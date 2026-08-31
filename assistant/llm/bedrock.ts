/**
 * AWS Bedrock implementation of the `LlmProvider` seam (design D-3/T-3),
 * closing the gap ASSISTANT.md previously documented as "not implemented".
 *
 * Uses the Mantle client (`AnthropicBedrockMantle` from
 * `@anthropic-ai/bedrock-sdk`), which exposes the same `messages.create` /
 * `.stream` surface as the first-party `@anthropic-ai/sdk` client — the
 * request/response shapes here are identical to anthropic.ts (same
 * `MessageParam`/`Tool` types, same streaming events), so message conversion
 * is reused from there rather than duplicated.
 *
 * AWS credentials are never read by this repo's own config — they're
 * resolved by the SDK's standard precedence: an explicit
 * `AWS_BEARER_TOKEN_BEDROCK` bearer token, then `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the default AWS
 * credential chain (`~/.aws/credentials`, SSO, or an EC2/ECS/Lambda role) —
 * the same resolution any AWS CLI/SDK tool uses. Only `AWS_REGION` (or
 * `AWS_DEFAULT_REGION`) is validated up front in config.ts, since the Mantle
 * client throws immediately at construction if neither is set.
 */
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { toAnthropicMessage } from "./anthropic.js";
import type { LlmAssistantBlock, LlmProvider, StreamTurnArgs, StreamTurnEvents, StreamTurnResult } from "./provider.js";

export class BedrockProvider implements LlmProvider {
  private client: AnthropicBedrockMantle;

  constructor(
    awsRegion: string,
    private model: string,
    private maxOutputTokens: number,
  ) {
    this.client = new AnthropicBedrockMantle({ awsRegion });
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
    // Same defensive stance as anthropic.ts — the loop's caller handles
    // whatever `finalMessage()` rejects with.
    stream.on("error", () => {});

    const final = await stream.finalMessage();
    const blocks: LlmAssistantBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return { blocks, stopReason: final.stop_reason ?? "end_turn" };
  }
}
