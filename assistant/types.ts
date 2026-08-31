/**
 * Shared domain types (design §4). Split into their own module (not part of
 * the design's file list) purely to avoid a circular import between
 * registry.ts, tools.ts and session.ts — no behavior lives here.
 */
import type { LlmMessage } from "./llm/provider.js";

export type ServerId = string;
export type Trust = "builtin" | "user";
export type ConnStatus = "connecting" | "connected" | "error" | "disabled";

export type ServerTransportSpec =
  | { kind: "in-process" }
  | { kind: "streamable-http"; url: string; headers?: Record<string, string> };

export interface RegisteredTool {
  alias: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  resourceUri?: string;
  appOnly: boolean;
  modelOnly: boolean;
  offeredToModel: boolean;
  widgetUnavailable?: boolean;
}

export interface ServerRecord {
  id: ServerId;
  name: string;
  transport: ServerTransportSpec;
  trust: Trust;
  removable: boolean;
  enabled: boolean;
  status: ConnStatus;
  lastError?: { message: string; code: string; at: string };
  serverInfo?: { name: string; version: string };
  serverCapabilities?: Record<string, unknown>;
  tools: RegisteredTool[];
  connectedAt?: string;
  declinedCapabilityNotice?: boolean;
}

/** Public projection sent to the browser: `transport.headers` is never included. */
export type PublicServerRecord = Omit<ServerRecord, "transport"> & {
  transport: { kind: "in-process" } | { kind: "streamable-http"; url: string };
};

export function toPublicServerRecord(s: ServerRecord): PublicServerRecord {
  const transport: PublicServerRecord["transport"] =
    s.transport.kind === "in-process" ? { kind: "in-process" } : { kind: "streamable-http", url: s.transport.url };
  return { ...s, transport };
}

export type ApprovalDecision = "once" | "session" | "deny";

export interface WidgetBinding {
  widgetInstanceId: string;
  serverId: ServerId;
  toolName: string;
  resourceUri: string;
  trust: Trust;
  createdAt: number;
  alive: boolean;
  callCount: number;
  callTimestamps: number[];
}

export interface ModelContextSnapshot {
  widgetInstanceId: string;
  serverName: string;
  toolName: string;
  text: string;
  at: number;
}

export interface ActiveTurn {
  id: string;
  abort: AbortController;
  startedAt: number;
  pendingApprovals: Map<string, (d: ApprovalDecision) => void>;
}

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  messages: LlmMessage[];
  widgets: Map<string, WidgetBinding>;
  modelContext: Map<string, ModelContextSnapshot>;
  approvals: Map<string, "session">;
  activeTurn?: ActiveTurn;
}
