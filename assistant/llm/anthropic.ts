import Anthropic from "@anthropic-ai/sdk";
import type { LlmAssistantBlock, LlmMessage, LlmProvider, StreamTurnArgs, StreamTurnEvents, StreamTurnResult } from "./provider.js";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private model: string,
    private maxOutputTokens: number,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async streamTurn(a: StreamTurnArgs, e: StreamTurnEvents): Promise<StreamTurnResult> {
    const messages = a.messages.map(toAnthropicMessage);
    const tools: Anthropic.Messages.Tool[] = a.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: "object" } as Anthropic.Messages.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: a.system,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      },
      { signal: a.signal },
    );

    stream.on("text", (delta) => e.onTextDelta(delta));
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        e.onToolUseStart(event.content_block.id, event.content_block.name);
      }
    });
    // Never let a stream-level error crash the process — the loop's caller
    // catches whatever `finalMessage()` rejects with (see loop.ts, R-1's
    // defensive-400-handling requirement).
    stream.on("error", () => {});

    const final = await stream.finalMessage();
    const blocks: LlmAssistantBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
      // Other block types (thinking, server_tool_use, ...) are not requested
      // by this integration and are silently ignored rather than crashing the turn.
    }
    return { blocks, stopReason: final.stop_reason ?? "end_turn" };
  }
}

/** Exported for reuse by bedrock.ts — Bedrock's Mantle client speaks the same Messages API shape. */
export function toAnthropicMessage(m: LlmMessage): Anthropic.Messages.MessageParam {
  if (m.role === "user") {
    return {
      role: "user",
      content: m.content.map((b): Anthropic.Messages.ContentBlockParam =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "tool_result", tool_use_id: b.toolUseId, is_error: b.isError, content: b.text },
      ),
    };
  }
  return {
    role: "assistant",
    content: m.content.map((b): Anthropic.Messages.ContentBlockParam =>
      b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input },
    ),
  };
}
