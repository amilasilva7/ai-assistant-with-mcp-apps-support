/**
 * `fetch` wrappers + NDJSON stream reader (design §5.2). Types here are a
 * deliberate, small duplication of `assistant/turnEvents.ts` rather than a
 * cross-directory import: the frontend build (`vite.assistant.config.ts`)
 * roots at `ui/assistant`, and keeping the wire contract as plain,
 * self-contained types avoids coupling the SPA's module graph to the
 * backend's directory layout.
 */

export type Trust = "builtin" | "user";

export interface ContentBlockLike {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ErrorCode =
  | "CONFIG_INVALID"
  | "LLM_AUTH"
  | "LLM_RATE_LIMIT"
  | "LLM_ERROR"
  | "LLM_STREAM_ABORTED"
  | "SERVER_UNREACHABLE"
  | "TOOL_TIMEOUT"
  | "TOOL_ERROR"
  | "TOOL_UNKNOWN_ALIAS"
  | "TOOL_DENIED"
  | "RATE_LIMITED"
  | "SESSION_NOT_FOUND";

export type StopReason = "end_turn" | "max_iterations" | "max_calls" | "timeout" | "cancelled" | "error";

export type TurnEvent =
  | { t: "turn_start"; turnId: string }
  | { t: "text_delta"; text: string }
  | {
      t: "tool_call_start";
      callId: string;
      alias: string;
      serverId: string;
      serverName: string;
      toolName: string;
      trust: Trust;
      resourceUri?: string;
      widgetUnavailable?: boolean;
      mountable: boolean;
    }
  | { t: "tool_approval_request"; callId: string; serverName: string; toolName: string }
  | { t: "tool_approved"; callId: string }
  | { t: "tool_call_input"; callId: string; arguments: Record<string, unknown> }
  | {
      t: "tool_call_result";
      callId: string;
      ok: true;
      durationMs: number;
      truncated: boolean;
      content: ContentBlockLike[];
      structuredContent?: unknown;
      isError?: boolean;
    }
  | { t: "tool_call_error"; callId: string; code: ErrorCode; message: string; durationMs: number }
  | { t: "notice"; level: "info" | "warn"; message: string }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "turn_end"; stopReason: StopReason; iterations: number };

export interface PublicServerRecord {
  id: string;
  name: string;
  transport: { kind: "in-process" } | { kind: "streamable-http"; url: string };
  trust: Trust;
  removable: boolean;
  enabled: boolean;
  status: "connecting" | "connected" | "error" | "disabled";
  lastError?: { message: string; code: string; at: string };
  tools: Array<{
    alias: string;
    name: string;
    title?: string;
    description?: string;
    resourceUri?: string;
    appOnly: boolean;
    modelOnly: boolean;
    offeredToModel: boolean;
    widgetUnavailable?: boolean;
  }>;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { error: res.statusText };
    }
    const err = new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function createSession(): Promise<string> {
  const res = await fetch("/api/session", { method: "POST" });
  const { sessionId } = await asJson<{ sessionId: string }>(res);
  return sessionId;
}

export async function getConfig(): Promise<{ model: string; widgetInitTimeoutMs: number; maxToolIterations: number; buildWarnings: string[] }> {
  const res = await fetch("/api/config");
  return asJson(res);
}

export async function listServers(): Promise<PublicServerRecord[]> {
  const res = await fetch("/api/servers");
  const { servers } = await asJson<{ servers: PublicServerRecord[] }>(res);
  return servers;
}

export async function addServer(url: string, name?: string): Promise<PublicServerRecord> {
  const res = await fetch("/api/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, name }) });
  const { server } = await asJson<{ server: PublicServerRecord }>(res);
  return server;
}

export async function setServerEnabled(id: string, enabled: boolean): Promise<PublicServerRecord> {
  const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const { server } = await asJson<{ server: PublicServerRecord }>(res);
  return server;
}

export async function removeServer(id: string): Promise<void> {
  const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) await asJson(res);
}

export async function reconnectServer(id: string): Promise<PublicServerRecord> {
  const res = await fetch(`/api/servers/${encodeURIComponent(id)}/reconnect`, { method: "POST" });
  const { server } = await asJson<{ server: PublicServerRecord }>(res);
  return server;
}

export class ChatConflictError extends Error {}

/**
 * POSTs a prompt and streams back NDJSON turn events. Used for both
 * user-submitted prompts and widget-initiated (`source:"app"`) messages —
 * they share the same endpoint and therefore the same G-e concurrency
 * policy (409 if a turn is already active for the session).
 */
export async function streamChat(
  sessionId: string,
  prompt: string,
  source: "user" | "app",
  onEvent: (e: TurnEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt, source }),
  });
  if (res.status === 409) {
    throw new ChatConflictError("A turn is already active for this session.");
  }
  if (!res.ok || !res.body) {
    await asJson(res);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") continue;
      try {
        onEvent(JSON.parse(line) as TurnEvent);
      } catch {
        // Ignore a malformed line rather than aborting the whole stream.
      }
    }
  }
}

export async function cancelChat(sessionId: string): Promise<void> {
  await fetch("/api/chat/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
}

export async function approveToolCall(sessionId: string, callId: string, decision: "once" | "session" | "deny"): Promise<void> {
  await fetch("/api/chat/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, callId, decision }) });
}

export interface BootstrapResponse {
  html: string;
  mimeType?: string;
  trust: Trust;
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  permissions?: Record<string, object>;
  prefersBorder?: boolean;
}

export async function bootstrapWidget(sessionId: string, widgetInstanceId: string): Promise<BootstrapResponse> {
  const res = await fetch("/api/mcp/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, widgetInstanceId }),
  });
  return asJson(res);
}

export async function teardownWidget(sessionId: string, widgetInstanceId: string): Promise<void> {
  await fetch(`/api/widget/${encodeURIComponent(widgetInstanceId)}/teardown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}
