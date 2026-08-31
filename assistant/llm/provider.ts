/**
 * Provider-neutral seam (D-3). One method wide on purpose: a second provider
 * can be added later without touching the loop, the registry, or the UI.
 */

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmUserBlock = { type: "text"; text: string } | { type: "tool_result"; toolUseId: string; isError?: boolean; text: string };

export type LlmAssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type LlmMessage = { role: "user"; content: LlmUserBlock[] } | { role: "assistant"; content: LlmAssistantBlock[] };

export interface StreamTurnArgs {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  signal: AbortSignal;
}

export interface StreamTurnEvents {
  onTextDelta(text: string): void;
  /** Fires before a tool_use block's arguments finish streaming (FR-A3, early widget mount). */
  onToolUseStart(id: string, name: string): void;
}

export interface StreamTurnResult {
  blocks: LlmAssistantBlock[];
  stopReason: string;
}

export interface LlmProvider {
  streamTurn(args: StreamTurnArgs, events: StreamTurnEvents): Promise<StreamTurnResult>;
}
