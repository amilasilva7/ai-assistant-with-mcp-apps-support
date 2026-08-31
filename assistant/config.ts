/**
 * Reads and validates every env var the assistant needs, and throws one
 * aggregated, actionable error on startup (FR-B2) rather than failing on the
 * first bad value.
 *
 * Deviation from the design doc's literal text (review R-4): the design
 * proposed `node --env-file=.env`, but that throws ENOENT when `.env` is
 * absent (e.g. a user who exports ANTHROPIC_API_KEY in their shell instead of
 * using a file). Loading is done here, programmatically, and is a no-op if
 * `.env` does not exist.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    // Don't crash here — surface it as part of the aggregated config error
    // below only if it actually left a required var unset. A malformed .env
    // with an otherwise-valid shell environment should still be able to boot.
    console.error(`[config] could not parse ${envPath}: ${(err as Error).message}`);
  }
}

export interface SeedServer {
  name?: string;
  url: string;
  headers?: Record<string, string>;
}

export interface Config {
  anthropicApiKey: string;
  geminiApiKey: string;
  ollamaBaseUrl: string;
  awsRegion: string;
  model: string;
  llmProvider: "anthropic" | "gemini" | "ollama" | "bedrock";
  port: number;
  bind: string;
  allowRemote: boolean;
  publicOrigin: string | null;
  seedServers: SeedServer[];
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  connectTimeoutMs: number;
  maxToolResultChars: number;
  maxModelContextChars: number;
  maxHistoryMessages: number;
  maxOutputTokens: number;
  widgetInitTimeoutMs: number;
  logLevel: "debug" | "info";
}

class ConfigErrors {
  problems: string[] = [];

  requireString(name: string): string {
    const v = process.env[name];
    if (!v || v.trim() === "") {
      this.problems.push(`${name} is required but not set.`);
      return "";
    }
    return v;
  }

  int(name: string, def: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw.trim()) {
      this.problems.push(`${name}="${raw}" is not a valid integer.`);
      return def;
    }
    return n;
  }

  json<T>(name: string, def: T): T {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return def;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.problems.push(`${name} is not valid JSON: ${(err as Error).message}`);
      return def;
    }
  }
}

export function loadConfig(): Config {
  const e = new ConfigErrors();

  const llmProviderRaw = process.env.ASSISTANT_LLM_PROVIDER?.trim() || "anthropic";
  if (!["anthropic", "gemini", "ollama", "bedrock"].includes(llmProviderRaw)) {
    e.problems.push(`ASSISTANT_LLM_PROVIDER="${llmProviderRaw}" is not supported; use "anthropic", "gemini", "ollama", or "bedrock".`);
  }
  const llmProvider: "anthropic" | "gemini" | "ollama" | "bedrock" =
    llmProviderRaw === "gemini"
      ? "gemini"
      : llmProviderRaw === "ollama"
        ? "ollama"
        : llmProviderRaw === "bedrock"
          ? "bedrock"
          : "anthropic";

  // Only the selected provider's key is required — this repo runs one
  // provider at a time (temporary swap, not a fallback chain). Ollama has no
  // key at all: it's an unauthenticated local server. Bedrock has no key
  // either — AWS credentials are resolved by the SDK's own standard chain
  // (env vars, shared config file, SSO, or an instance/task role), not by
  // this repo's config; only the region is validated here, since the client
  // throws immediately at construction if it can't determine one.
  const anthropicApiKey = llmProvider === "anthropic" ? e.requireString("ANTHROPIC_API_KEY") : "";
  const geminiApiKey = llmProvider === "gemini" ? e.requireString("GEMINI_API_KEY") : "";
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
  const awsRegion = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "";
  if (llmProvider === "bedrock" && !awsRegion) {
    e.problems.push("AWS_REGION (or AWS_DEFAULT_REGION) is required when ASSISTANT_LLM_PROVIDER=bedrock.");
  }
  const model =
    process.env.ASSISTANT_MODEL?.trim() ||
    (llmProvider === "gemini"
      ? "gemini-3.6-flash"
      : llmProvider === "ollama"
        ? "llama3.1:8b"
        : llmProvider === "bedrock"
          ? "anthropic.claude-sonnet-4-5-20250929-v1:0"
          : "claude-sonnet-4-5-20250929");

  const port = e.int("ASSISTANT_PORT", 3002);
  const bind = process.env.ASSISTANT_BIND?.trim() || "127.0.0.1";
  const allowRemote = process.env.ASSISTANT_ALLOW_REMOTE === "1";
  if (bind !== "127.0.0.1" && bind !== "localhost" && !allowRemote) {
    e.problems.push(
      `ASSISTANT_BIND="${bind}" is not loopback. Set ASSISTANT_ALLOW_REMOTE=1 to acknowledge the risk (LLM credit spend, SSRF pivot) if this is intentional.`,
    );
  }

  // Exact-origin allowlist entry for fronting the assistant with a tunnel
  // (e.g. `cloudflared tunnel --url http://localhost:3002`). ASSISTANT_BIND
  // stays loopback — the tunnel client makes the outbound connection and
  // proxies back to 127.0.0.1 locally — but the Origin/Host guard below only
  // knows about loopback names, so a browser hitting the public URL would
  // otherwise get 403'd on every request. This does not add authentication:
  // it only widens the guard from "loopback only" to "loopback or this one
  // specific origin," so anyone with the tunnel URL still has full access.
  let publicOrigin: string | null = null;
  const publicOriginRaw = process.env.ASSISTANT_PUBLIC_ORIGIN?.trim();
  if (publicOriginRaw) {
    try {
      const u = new URL(publicOriginRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("must be http/https");
      publicOrigin = u.origin;
    } catch {
      e.problems.push(`ASSISTANT_PUBLIC_ORIGIN="${publicOriginRaw}" is not a valid http(s) URL.`);
    }
  }

  const seedServers = e.json<SeedServer[]>("ASSISTANT_SERVERS", []);
  if (!Array.isArray(seedServers)) {
    e.problems.push("ASSISTANT_SERVERS must be a JSON array.");
  }

  const config: Config = {
    anthropicApiKey,
    geminiApiKey,
    ollamaBaseUrl,
    awsRegion,
    model,
    llmProvider,
    port,
    bind,
    allowRemote,
    publicOrigin,
    seedServers: Array.isArray(seedServers) ? seedServers : [],
    maxToolIterations: e.int("ASSISTANT_MAX_TOOL_ITERATIONS", 8),
    maxToolCallsPerTurn: e.int("ASSISTANT_MAX_TOOL_CALLS_PER_TURN", 16),
    turnTimeoutMs: e.int("ASSISTANT_TURN_TIMEOUT_MS", 120_000),
    toolTimeoutMs: e.int("ASSISTANT_TOOL_TIMEOUT_MS", 30_000),
    connectTimeoutMs: e.int("ASSISTANT_CONNECT_TIMEOUT_MS", 10_000),
    maxToolResultChars: e.int("ASSISTANT_MAX_TOOL_RESULT_CHARS", 24_000),
    maxModelContextChars: e.int("ASSISTANT_MAX_MODEL_CONTEXT_CHARS", 4_000),
    maxHistoryMessages: e.int("ASSISTANT_MAX_HISTORY_MESSAGES", 40),
    maxOutputTokens: e.int("ASSISTANT_MAX_OUTPUT_TOKENS", 4_096),
    widgetInitTimeoutMs: e.int("ASSISTANT_WIDGET_INIT_TIMEOUT_MS", 5_000),
    logLevel: process.env.ASSISTANT_LOG_LEVEL === "debug" ? "debug" : "info",
  };

  if (e.problems.length > 0) {
    throw new Error(
      `Invalid assistant configuration:\n` + e.problems.map((p) => `  - ${p}`).join("\n") + `\n\nSee .env.example.`,
    );
  }

  return Object.freeze(config);
}
