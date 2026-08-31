/**
 * Console-only observability (NFR-Observability-1), matching server/main.ts's
 * style. No log files, no external sink.
 */
import type { Config } from "./config.js";

let logLevel: "debug" | "info" = "info";

export function initLogging(config: Config): void {
  logLevel = config.logLevel;
}

const REDACT_KEY_RE = /(key|token|secret|authorization|password)/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_RE.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

function truncateJson(value: unknown, maxChars = 500): string {
  let text: string;
  try {
    text = JSON.stringify(redact(value));
  } catch {
    text = String(value);
  }
  if (text.length > maxChars) {
    return text.slice(0, maxChars) + `…[${text.length - maxChars} more chars]`;
  }
  return text;
}

export function logToolCall(fields: {
  server: string;
  tool: string;
  alias?: string;
  caller: "model" | "widget";
  args: unknown;
  ok: boolean;
  ms: number;
  chars: number;
  truncated: boolean;
}): void {
  console.log(
    `[tool] server=${fields.server} tool=${fields.tool}` +
      (fields.alias ? ` alias=${fields.alias}` : "") +
      ` caller=${fields.caller} args=${truncateJson(fields.args)} ok=${fields.ok} ms=${fields.ms} chars=${fields.chars} truncated=${fields.truncated}`,
  );
}

export function logTurn(fields: { turnId: string; iterations: number; ms: number; stopReason: string }): void {
  console.log(`[turn] id=${fields.turnId} iterations=${fields.iterations} ms=${fields.ms} stopReason=${fields.stopReason}`);
}

export function logServerStatus(serverId: string, status: string, detail?: string): void {
  console.log(`[server] id=${serverId} status=${status}${detail ? ` detail=${detail}` : ""}`);
}

export function logOpenLink(server: string, url: string, decision: string): void {
  console.log(`[openlink] server=${server} url=${url} decision=${decision}`);
}

export function logWidget(fields: { widgetInstanceId: string; event: string; detail?: string }): void {
  console.log(`[widget] id=${fields.widgetInstanceId} event=${fields.event}${fields.detail ? ` detail=${fields.detail}` : ""}`);
}

export function logDebug(...args: unknown[]): void {
  if (logLevel === "debug") console.log("[debug]", ...args);
}

export function logError(context: string, error: unknown): void {
  console.error(`MCP error: [${context}]`, error instanceof Error ? error.message : error);
}
