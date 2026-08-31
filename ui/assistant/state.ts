/**
 * Transcript reducer + action types (design §3.2's `state.ts`), driven by the
 * `TurnEvent` union from `api.ts`.
 *
 * Ordering the reducer honours (design §5.2/§6.2): `tool_call_start` (mounts
 * the card even before args/result exist) -> optional `tool_approval_request`
 * -> `tool_call_input` -> exactly one of `tool_call_result`/`tool_call_error`.
 * `turn_end` always arrives last; any tool call still pending at that point is
 * marked `cancelled` so its `WidgetFrame` gets `sendToolCancelled`.
 */
import type { ContentBlockLike, StopReason, Trust, TurnEvent } from "./api";

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  source: "user" | "app";
}

export interface AssistantTextItem {
  kind: "assistant_text";
  id: string;
  text: string;
  streaming: boolean;
}

export type ApprovalDecision = "once" | "session" | "deny";

export interface ToolCallItem {
  kind: "tool_call";
  id: string; // === callId
  callId: string;
  alias: string;
  serverId: string;
  serverName: string;
  toolName: string;
  trust: Trust;
  resourceUri?: string;
  widgetUnavailable?: boolean;
  mountable: boolean;
  approvalPending: boolean;
  approvalDecision?: ApprovalDecision;
  input?: Record<string, unknown>;
  result?: {
    durationMs: number;
    truncated: boolean;
    content: ContentBlockLike[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: string; message: string; durationMs: number };
  cancelled?: boolean;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warn";
  message: string;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  code: string;
  message: string;
}

export type TranscriptItem = UserItem | AssistantTextItem | ToolCallItem | NoticeItem | ErrorItem;

export interface AppState {
  transcript: TranscriptItem[];
  turnActive: boolean;
  streamingAssistantId: string | null;
  liveStatus: string;
  lastStopReason?: StopReason;
}

export const initialState: AppState = {
  transcript: [],
  turnActive: false,
  streamingAssistantId: null,
  liveStatus: "",
};

export type Action =
  | { type: "submit_prompt"; text: string; source: "user" | "app" }
  | { type: "turn_event"; event: TurnEvent }
  | { type: "turn_failed"; message: string }
  | { type: "host_notice"; level: "info" | "warn"; message: string };

function newId(): string {
  return crypto.randomUUID();
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "submit_prompt": {
      const userItem: UserItem = { kind: "user", id: newId(), text: action.text, source: action.source };
      return {
        ...state,
        transcript: [...state.transcript, userItem],
        turnActive: true,
        streamingAssistantId: null,
        liveStatus: "Thinking…",
      };
    }
    case "turn_event":
      return applyTurnEvent(state, action.event);
    case "turn_failed": {
      const errItem: ErrorItem = { kind: "error", id: newId(), code: "CLIENT_ERROR", message: action.message };
      return { ...state, transcript: [...state.transcript, errItem], turnActive: false, liveStatus: `Error: ${action.message}` };
    }
    case "host_notice": {
      const item: NoticeItem = { kind: "notice", id: newId(), level: action.level, message: action.message };
      return { ...state, transcript: [...state.transcript, item] };
    }
    default:
      return state;
  }
}

function updateToolCall(state: AppState, callId: string, patch: Partial<ToolCallItem>): AppState {
  return {
    ...state,
    transcript: state.transcript.map((item) => (item.kind === "tool_call" && item.callId === callId ? { ...item, ...patch } : item)),
  };
}

function toolLabel(state: AppState, callId: string): string {
  const item = state.transcript.find((i): i is ToolCallItem => i.kind === "tool_call" && i.callId === callId);
  return item ? `${item.serverName} · ${item.toolName}` : "Tool call";
}

function stopReasonLabel(reason: StopReason): string {
  switch (reason) {
    case "end_turn":
      return "Done.";
    case "max_iterations":
      return "Reached the tool-call iteration limit.";
    case "max_calls":
      return "Reached this turn's tool-call limit.";
    case "timeout":
      return "The turn timed out.";
    case "cancelled":
      return "Generation stopped.";
    case "error":
      return "The turn ended with an error.";
    default:
      return "Done.";
  }
}

function applyTurnEvent(state: AppState, event: TurnEvent): AppState {
  switch (event.t) {
    case "turn_start":
      return { ...state, liveStatus: "Thinking…" };

    case "text_delta": {
      if (state.streamingAssistantId) {
        return {
          ...state,
          transcript: state.transcript.map((item) =>
            item.kind === "assistant_text" && item.id === state.streamingAssistantId ? { ...item, text: item.text + event.text } : item,
          ),
        };
      }
      const id = newId();
      const item: AssistantTextItem = { kind: "assistant_text", id, text: event.text, streaming: true };
      return { ...state, transcript: [...state.transcript, item], streamingAssistantId: id, liveStatus: "Assistant is responding…" };
    }

    case "tool_call_start": {
      const item: ToolCallItem = {
        kind: "tool_call",
        id: event.callId,
        callId: event.callId,
        alias: event.alias,
        serverId: event.serverId,
        serverName: event.serverName,
        toolName: event.toolName,
        trust: event.trust,
        resourceUri: event.resourceUri,
        widgetUnavailable: event.widgetUnavailable,
        mountable: event.mountable,
        approvalPending: false,
      };
      return {
        ...state,
        transcript: [...state.transcript, item],
        liveStatus: `Calling ${event.serverName} · ${event.toolName}…`,
      };
    }

    case "tool_approval_request":
      return updateToolCall({ ...state, liveStatus: `Waiting for approval to call ${event.serverName} · ${event.toolName}…` }, event.callId, {
        approvalPending: true,
      });

    case "tool_approved":
      return updateToolCall(state, event.callId, { approvalPending: false, mountable: true });

    case "tool_call_input":
      return updateToolCall(state, event.callId, { input: event.arguments });

    case "tool_call_result": {
      const next = updateToolCall(state, event.callId, {
        approvalPending: false,
        result: {
          durationMs: event.durationMs,
          truncated: event.truncated,
          content: event.content,
          structuredContent: event.structuredContent,
          isError: event.isError,
        },
      });
      return { ...next, liveStatus: `${toolLabel(state, event.callId)} finished.` };
    }

    case "tool_call_error": {
      const next = updateToolCall(state, event.callId, {
        approvalPending: false,
        error: { code: event.code, message: event.message, durationMs: event.durationMs },
      });
      return { ...next, liveStatus: `${toolLabel(state, event.callId)} failed: ${event.message}` };
    }

    case "notice": {
      const item: NoticeItem = { kind: "notice", id: newId(), level: event.level, message: event.message };
      return { ...state, transcript: [...state.transcript, item] };
    }

    case "error": {
      const item: ErrorItem = { kind: "error", id: newId(), code: event.code, message: event.message };
      return { ...state, transcript: [...state.transcript, item], liveStatus: `Error: ${event.message}` };
    }

    case "turn_end": {
      const finalized = state.transcript.map((item): TranscriptItem => {
        if (item.kind === "assistant_text" && item.id === state.streamingAssistantId) {
          return { ...item, streaming: false };
        }
        if (item.kind === "tool_call" && !item.result && !item.error && !item.cancelled) {
          return { ...item, cancelled: true, approvalPending: false };
        }
        return item;
      });
      return {
        ...state,
        transcript: finalized,
        turnActive: false,
        streamingAssistantId: null,
        lastStopReason: event.stopReason,
        liveStatus: stopReasonLabel(event.stopReason),
      };
    }

    default:
      return state;
  }
}
