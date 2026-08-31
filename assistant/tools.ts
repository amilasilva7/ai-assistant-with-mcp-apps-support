/**
 * Alias namespacing, visibility filtering, tool-metadata caps and schema
 * quarantine (design §5.5, D-5; review R-1 and G-c).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { LlmToolDef } from "./llm/provider.js";
import { getToolUiResourceUri, isToolVisibilityAppOnly, isToolVisibilityModelOnly } from "./uiMeta.js";
import type { RegisteredTool, ServerRecord } from "./types.js";

// --- G-c: caps on untrusted tool metadata -----------------------------------
// One malicious/misbehaving MCP server must not be able to blow up context
// size or cost for every turn. Tools beyond these caps are dropped (logged),
// not fatal to the server connection.
export const MAX_TOOLS_PER_SERVER = 300;
export const MAX_TOOL_NAME_CHARS = 128;
export const MAX_TOOL_DESCRIPTION_CHARS = 4_000;
export const MAX_TOOL_SCHEMA_BYTES = 8_000;

export interface DroppedTool {
  name: string;
  reason: "tool-count-cap" | "name-too-long" | "description-too-long" | "schema-too-large" | "malformed-schema";
}

export interface ToolBuildResult {
  tools: RegisteredTool[];
  dropped: DroppedTool[];
}

/**
 * R-1: validate that `inputSchema` is a well-formed object-rooted JSON
 * Schema before it is ever handed to the LLM provider. Anthropic rejects a
 * non-conforming `input_schema` with a 400 on the *entire* request, and
 * because the tool list is aggregated across every connected server, one bad
 * tool would otherwise break every turn — a direct NFR-Reliability-1
 * violation. Non-conforming tools are dropped here (and logged) instead.
 *
 * This is intentionally a shallow structural check, not a full JSON Schema
 * validator: it catches the failure modes that actually reach this shape
 * (non-object root, shorthand/primitive property definitions, non-array
 * `required`) without taking on a JSON Schema implementation.
 */
export function isWellFormedObjectJsonSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined && s.type !== "object") return false;
  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) return false;
    for (const propSchema of Object.values(s.properties as Record<string, unknown>)) {
      if (typeof propSchema !== "object" || propSchema === null || Array.isArray(propSchema)) return false;
    }
  }
  if (s.required !== undefined && !Array.isArray(s.required)) return false;
  return true;
}

export function buildRegisteredTools(rawTools: Tool[], serverLabel: string): ToolBuildResult {
  const dropped: DroppedTool[] = [];
  let list = rawTools;
  if (list.length > MAX_TOOLS_PER_SERVER) {
    for (const t of list.slice(MAX_TOOLS_PER_SERVER)) dropped.push({ name: t.name, reason: "tool-count-cap" });
    console.warn(
      `[tools] server="${serverLabel}" exposes ${list.length} tools; capping at ${MAX_TOOLS_PER_SERVER} (G-c)`,
    );
    list = list.slice(0, MAX_TOOLS_PER_SERVER);
  }

  const tools: RegisteredTool[] = [];
  for (const t of list) {
    if (t.name.length > MAX_TOOL_NAME_CHARS) {
      dropped.push({ name: t.name, reason: "name-too-long" });
      console.warn(`[tools] server="${serverLabel}" dropped tool (name exceeds ${MAX_TOOL_NAME_CHARS} chars): ${t.name.slice(0, 40)}…`);
      continue;
    }
    if ((t.description?.length ?? 0) > MAX_TOOL_DESCRIPTION_CHARS) {
      dropped.push({ name: t.name, reason: "description-too-long" });
      console.warn(`[tools] server="${serverLabel}" tool="${t.name}" dropped: description exceeds ${MAX_TOOL_DESCRIPTION_CHARS} chars`);
      continue;
    }
    let schemaBytes: number;
    try {
      schemaBytes = JSON.stringify(t.inputSchema ?? {}).length;
    } catch {
      schemaBytes = Number.POSITIVE_INFINITY;
    }
    if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
      dropped.push({ name: t.name, reason: "schema-too-large" });
      console.warn(`[tools] server="${serverLabel}" tool="${t.name}" dropped: input schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`);
      continue;
    }
    if (!isWellFormedObjectJsonSchema(t.inputSchema)) {
      dropped.push({ name: t.name, reason: "malformed-schema" });
      console.warn(`[tools] server="${serverLabel}" tool="${t.name}" dropped: input schema is not a well-formed object-rooted JSON Schema (R-1)`);
      continue;
    }

    tools.push({
      alias: "", // assigned by assignAliases()
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      resourceUri: getToolUiResourceUri(t),
      appOnly: isToolVisibilityAppOnly(t),
      modelOnly: isToolVisibilityModelOnly(t),
      offeredToModel: !isToolVisibilityAppOnly(t),
      widgetUnavailable: false,
    });
  }
  return { tools, dropped };
}

// --- D-5: alias namespacing ---------------------------------------------

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "server";
}

function hash4(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(4, "0").slice(0, 4);
}

/**
 * Recomputes `.alias` for every tool on every server, in place. Deterministic
 * given (server order, tool order). Called whenever any server's tool set
 * changes (design §5.5 point 3); the routing map used by an in-flight turn is
 * a separate snapshot (see `snapshotToolRouting`) so this cannot re-point a
 * call that is already underway.
 */
export function assignAliases(servers: ServerRecord[]): void {
  const used = new Set<string>();
  for (const server of servers) {
    const prefix = slugify(server.id);
    for (const tool of server.tools) {
      const toolPart = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
      let alias = `${prefix}__${toolPart}`;
      if (alias.length > 64) {
        const hash = hash4(tool.name);
        const fixed = prefix.length + 2 + 1 + hash.length; // prefix + "__" + "_" + hash
        const room = Math.max(0, 64 - fixed);
        alias = `${prefix}__${toolPart.slice(0, room)}_${hash}`;
      }
      let candidate = alias;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${alias}_${n++}`;
      }
      used.add(candidate);
      tool.alias = candidate;
    }
  }
}

/** Keeps `offeredToModel` in sync with server-level enable/connect state. */
export function refreshOfferedToModel(server: ServerRecord): void {
  const active = server.enabled && server.status === "connected";
  for (const tool of server.tools) {
    tool.offeredToModel = active && !tool.appOnly;
  }
}

export interface ToolRoute {
  serverId: string;
  toolName: string;
  tool: RegisteredTool;
  server: ServerRecord;
}

/** Snapshot the alias -> route mapping. Stable within a turn (design §5.5 point 3). */
export function snapshotToolRouting(servers: ServerRecord[]): Map<string, ToolRoute> {
  const map = new Map<string, ToolRoute>();
  for (const server of servers) {
    for (const tool of server.tools) {
      if (tool.alias) map.set(tool.alias, { serverId: server.id, toolName: tool.name, tool, server });
    }
  }
  return map;
}

/**
 * Best-effort repair of loosely-typed tool arguments against the tool's own
 * JSON Schema, before dispatch. Added for smaller/local models (e.g. Ollama's
 * llama3.1:8b via assistant/llm/ollama.ts) which are noticeably less
 * reliable than Claude/Gemini at conforming to a declared schema —
 * observed in practice sending `{"days":"30"}` (string, schema says integer)
 * and, across different calls, `{"region":""}` and `{"region":"null"}` for
 * an optional enum field it should have omitted entirely. Anthropic/Gemini
 * essentially never need this; it only acts
 * when a value doesn't already match the declared type, so it's a no-op for
 * well-formed input. Deliberately narrow — it does not attempt to repair
 * wrong enum values, malformed nested objects, or missing required fields;
 * those are real errors and should still surface as validation failures.
 */
export function coerceToolArgs(inputSchema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;
  if (!properties || typeof properties !== "object") return args;
  const required = new Set(((inputSchema as { required?: unknown }).required as string[] | undefined) ?? []);

  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!propSchema || typeof propSchema !== "object") continue;

    if ((propSchema.type === "number" || propSchema.type === "integer") && typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = propSchema.type === "integer" ? Math.trunc(n) : n;
      continue;
    }
    if (propSchema.type === "boolean" && typeof value === "string") {
      if (value === "true") out[key] = true;
      else if (value === "false") out[key] = false;
      continue;
    }
    // An optional enum field set to something other than one of its actual
    // values — "", "null", "none", a hallucinated option — is a common "I
    // don't want to set this" artifact from smaller models. Drop it so the
    // tool's own default applies instead of failing enum validation. Scoped
    // to enum fields specifically so a genuinely wrong *required* value, or
    // a wrong value on a field with no fixed option set, still errors.
    if (Array.isArray(propSchema.enum) && typeof value === "string" && !propSchema.enum.includes(value) && !required.has(key)) {
      delete out[key];
    }
  }
  return out;
}

export function modelFacingTools(servers: ServerRecord[]): LlmToolDef[] {
  const defs: LlmToolDef[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      if (!tool.offeredToModel) continue;
      defs.push({
        name: tool.alias,
        description: `[server: ${server.name}] ${tool.description ?? tool.title ?? tool.name}`,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return defs;
}
