import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Trust } from "./types.js";

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

/**
 * NDJSON turn stream event union (design §5.2), extended with `tool_approved`
 * (review R-2 correction): for tools on `trust: "user"` servers,
 * `tool_call_start` never carries a *mountable* widget until approval has
 * been granted — `mountable` tells the frontend whether it may fetch/mount
 * the widget iframe yet, and `tool_approved` flips it once the user
 * approves. Built-in-server tools are `mountable: true` from the start.
 */
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
      content: ContentBlock[];
      structuredContent?: unknown;
      isError?: boolean;
    }
  | { t: "tool_call_error"; callId: string; code: ErrorCode; message: string; durationMs: number }
  | { t: "notice"; level: "info" | "warn"; message: string }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "turn_end"; stopReason: StopReason; iterations: number };
