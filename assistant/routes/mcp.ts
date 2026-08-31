/**
 * Widget-facing proxy routes (§8.2's binding rule): every request carries
 * only `sessionId` + `widgetInstanceId`; the backend resolves the server and
 * authorization from the session's `WidgetBinding` — the client never names
 * a server directly.
 *
 * Deviation from the design's literal text (review G-b): the design put a
 * single `/api/mcp/read-resource` route in charge of both (a) fetching the
 * widget's own bootstrap HTML and (b) proxying arbitrary `resources/read`
 * calls the mounted widget itself makes, and restricted both to
 * `binding.resourceUri` only. That makes (b) unusable for the ordinary MCP
 * Apps pattern of a widget reading a *different* data resource from its own
 * server. Here the two responsibilities are split:
 *   - `POST /api/mcp/bootstrap` — host-only, called by the frontend before
 *     the iframe exists, and scoped to exactly `binding.resourceUri`.
 *   - `POST /api/mcp/read-resource` — proxied `resources/read` from the
 *     mounted widget (via `AppBridge.onreadresource`), scoped to
 *     `binding.serverId` but allowed to read *any* URI on that server.
 */
import { Router } from "express";
import { RegistryError, type ServerRegistry } from "../registry.js";
import { logError } from "../log.js";
import type { SessionStore } from "../session.js";
import type { Config } from "../config.js";
import type { Session, WidgetBinding } from "../types.js";

const BINDING_WINDOW_MS = 10_000;
const BINDING_MAX_CALLS = 20;
const SESSION_WINDOW_MS = 60_000;
const SESSION_MAX_CALLS = 120;
const sessionCallTimestamps = new Map<string, number[]>();

function checkAndRecordRateLimit(binding: WidgetBinding, sessionId: string): boolean {
  const now = Date.now();
  binding.callTimestamps = binding.callTimestamps.filter((t) => now - t < BINDING_WINDOW_MS);
  if (binding.callTimestamps.length >= BINDING_MAX_CALLS) return false;
  binding.callTimestamps.push(now);

  const arr = (sessionCallTimestamps.get(sessionId) ?? []).filter((t) => now - t < SESSION_WINDOW_MS);
  if (arr.length >= SESSION_MAX_CALLS) return false;
  arr.push(now);
  sessionCallTimestamps.set(sessionId, arr);
  return true;
}

function resolve(
  sessions: SessionStore,
  sessionId: unknown,
  widgetInstanceId: unknown,
): { session: Session; binding: WidgetBinding } | { status: number; error: string } {
  if (typeof sessionId !== "string" || typeof widgetInstanceId !== "string") {
    return { status: 400, error: "sessionId and widgetInstanceId are required" };
  }
  const session = sessions.get(sessionId);
  if (!session) return { status: 404, error: "Unknown session" };
  const binding = session.widgets.get(widgetInstanceId);
  if (!binding) return { status: 404, error: "Unknown widget instance" };
  if (!binding.alive) return { status: 410, error: "This widget has been torn down" };
  return { session, binding };
}

export function createMcpRouter(deps: { sessions: SessionStore; registry: ServerRegistry; config: Config }): Router {
  const router = Router();

  router.post("/mcp/bootstrap", async (req, res) => {
    const { sessionId, widgetInstanceId } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { binding } = resolved;
    try {
      const result = await deps.registry.readResource(binding.serverId, binding.resourceUri, deps.config.connectTimeoutMs);
      const content = result.contents[0];
      if (!content || !("text" in content) || typeof content.text !== "string") {
        res.status(502).json({ error: "Widget resource returned no text content" });
        return;
      }
      const server = deps.registry.get(binding.serverId);
      // D-10: declared csp/permissions are honoured only for the built-in server.
      // `registerAppResource`'s read callback returns `_meta.ui` at the result
      // level (sibling to `contents`), per the SDK's own
      // `McpUiReadResourceResult` type — not nested inside a content item.
      const meta = (result as unknown as { _meta?: { ui?: Record<string, unknown> } })._meta?.ui;
      const honourMeta = server?.trust === "builtin";
      res.json({
        html: content.text,
        mimeType: content.mimeType,
        trust: binding.trust,
        csp: honourMeta ? meta?.csp : undefined,
        permissions: honourMeta ? meta?.permissions : undefined,
        prefersBorder: honourMeta ? meta?.prefersBorder : undefined,
      });
    } catch (err) {
      logError(`mcp:bootstrap:${widgetInstanceId}`, err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/mcp/read-resource", async (req, res) => {
    const { sessionId, widgetInstanceId, uri } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    if (typeof uri !== "string") {
      res.status(400).json({ error: "uri is required" });
      return;
    }
    const { session, binding } = resolved;
    if (!checkAndRecordRateLimit(binding, session.id)) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    try {
      const result = await deps.registry.readResource(binding.serverId, uri, deps.config.toolTimeoutMs);
      res.json(result);
    } catch (err) {
      res.status(err instanceof RegistryError ? err.status : 502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/mcp/call", async (req, res) => {
    const { sessionId, widgetInstanceId, name, arguments: args } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    if (typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const { session, binding } = resolved;
    if (!checkAndRecordRateLimit(binding, session.id)) {
      res.status(429).json({ isError: true, content: [{ type: "text", text: "Rate limit exceeded" }] });
      return;
    }
    const server = deps.registry.get(binding.serverId);
    const toolExists = server?.tools.some((t) => t.name === name);
    if (!toolExists) {
      res.status(404).json({ isError: true, content: [{ type: "text", text: `Tool "${name}" is not on this widget's server` }] });
      return;
    }
    binding.callCount++;
    const start = Date.now();
    try {
      const result = await deps.registry.callTool(binding.serverId, name, (args ?? {}) as Record<string, unknown>, deps.config.toolTimeoutMs);
      console.log(`[tool] server=${binding.serverId} tool=${name} caller=widget ok=${!result.isError} ms=${Date.now() - start}`);
      res.json(result);
    } catch (err) {
      console.log(`[tool] server=${binding.serverId} tool=${name} caller=widget ok=false ms=${Date.now() - start}`);
      res.status(502).json({ isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] });
    }
  });

  router.post("/mcp/list", async (req, res) => {
    const { sessionId, widgetInstanceId, what, cursor } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { session, binding } = resolved;
    if (!checkAndRecordRateLimit(binding, session.id)) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    try {
      const timeout = deps.config.toolTimeoutMs;
      if (what === "resources") {
        res.json(await deps.registry.listResources(binding.serverId, cursor, timeout));
      } else if (what === "resourceTemplates") {
        res.json(await deps.registry.listResourceTemplates(binding.serverId, cursor, timeout));
      } else if (what === "prompts") {
        res.json(await deps.registry.listPrompts(binding.serverId, cursor, timeout));
      } else {
        res.status(400).json({ error: 'what must be "resources" | "resourceTemplates" | "prompts"' });
      }
    } catch (err) {
      res.status(err instanceof RegistryError ? err.status : 502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/model-context", (req, res) => {
    const { sessionId, widgetInstanceId, content, structuredContent } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { session, binding } = resolved;
    const server = deps.registry.get(binding.serverId);
    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
    if (structuredContent !== undefined) {
      try {
        parts.push(JSON.stringify(structuredContent));
      } catch {
        /* ignore unserializable structuredContent */
      }
    }
    session.modelContext.set(widgetInstanceId as string, {
      widgetInstanceId: widgetInstanceId as string,
      serverName: server?.name ?? binding.serverId,
      toolName: binding.toolName,
      text: parts.join("\n\n").slice(0, deps.config.maxModelContextChars),
      at: Date.now(),
    });
    res.json({});
  });

  router.post("/widget/:widgetInstanceId/teardown", (req, res) => {
    const { sessionId } = req.body ?? {};
    const resolved = resolve(deps.sessions, sessionId, req.params.widgetInstanceId);
    if ("status" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    resolved.binding.alive = false;
    res.json({ ok: true });
  });

  return router;
}
