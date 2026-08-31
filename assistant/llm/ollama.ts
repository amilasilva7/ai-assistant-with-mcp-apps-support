/**
 * Ollama implementation of the `LlmProvider` seam (design D-3/T-3): a local,
 * rate-limit-free stand-in for POC development against a model running in
 * Docker (see scripts/start-with-ollama.sh). Uses Ollama's **native**
 * `/api/chat` endpoint (not the OpenAI-compatible shim) — verified against
 * the current docs (github.com/ollama/ollama/blob/main/docs/api.md) because
 * its wire format differs from every other provider here in ways worth
 * naming explicitly:
 *   - No API key. The server is unauthenticated on localhost.
 *   - Plain NDJSON (one JSON object per line), not SSE — no "data:" framing.
 *   - A tool call's `arguments` arrive as an already-parsed object, not a
 *     partial JSON string to accumulate — Ollama does not stream tool-call
 *     arguments incrementally the way OpenAI/Anthropic do.
 *   - **No id on tool calls at all.** Correlation for the result message is
 *     by `tool_name`, not by id (`{role:"tool", tool_name, content}`) — this
 *     provider generates a local id for the provider-neutral `tool_use`
 *     block (design's `LlmAssistantBlock`, which requires one) purely to
 *     satisfy that shared type; it never leaves this file.
 */
import type { LlmAssistantBlock, LlmMessage, LlmProvider, LlmToolDef, LlmUserBlock, StreamTurnArgs, StreamTurnEvents, StreamTurnResult } from "./provider.js";

export class OllamaApiError extends Error {
  constructor(
    public status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "OllamaApiError";
  }
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

/**
 * Ollama's `tool_result`/`tool` correlation is by name, and the
 * provider-neutral `LlmUserBlock` only carries `toolUseId` — same gap as
 * Gemini's, same fix: recover the name from the assistant `tool_use` blocks
 * already earlier in the conversation before any content is converted.
 */
function buildToolNameMap(messages: LlmMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") map.set(b.id, b.name);
    }
  }
  return map;
}

/**
 * Ollama's chat message is one role + one content string (+ optional
 * tool_calls) — unlike Anthropic/Gemini's content-block arrays. A single
 * `LlmMessage` can carry several blocks (e.g. one user turn with several
 * parallel tool_results, or one assistant turn with reasoning text plus
 * several tool calls), so each `LlmMessage` maps to *one or more* Ollama
 * messages: consecutive text is merged into one user/assistant message,
 * tool_use blocks all attach to that same assistant message's `tool_calls`,
 * and each tool_result becomes its own `{role:"tool", ...}` message (Ollama
 * has no way to carry more than one tool result per message).
 */
function toOllamaMessages(messages: LlmMessage[], toolNames: Map<string, string>): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content
        .filter((b): b is Extract<LlmUserBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      if (text) out.push({ role: "user", content: text });
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const name = toolNames.get(b.toolUseId) ?? b.toolUseId;
        out.push({ role: "tool", tool_name: name, content: b.isError ? `ERROR: ${b.text}` : b.text });
      }
    } else {
      const text = m.content
        .filter((b): b is Extract<LlmAssistantBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      const toolCalls: OllamaToolCall[] = m.content
        .filter((b): b is Extract<LlmAssistantBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ function: { name: b.name, arguments: b.input } }));
      out.push({ role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
    }
  }
  return out;
}

function toOllamaTool(t: LlmToolDef) {
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Ignore a malformed line rather than aborting the whole stream.
      }
    }
  }
}

export class OllamaProvider implements LlmProvider {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async streamTurn(a: StreamTurnArgs, e: StreamTurnEvents): Promise<StreamTurnResult> {
    const toolNames = buildToolNameMap(a.messages);
    const messages: OllamaMessage[] = [{ role: "system", content: a.system }, ...toOllamaMessages(a.messages, toolNames)];
    const body = { model: this.model, messages, tools: a.tools.length > 0 ? a.tools.map(toOllamaTool) : undefined, stream: true };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: a.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new OllamaApiError(undefined, `Could not reach Ollama at ${this.baseUrl} — is the container running? (${err instanceof Error ? err.message : String(err)})`);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new OllamaApiError(res.status, text);
    }

    const blocks: LlmAssistantBlock[] = [];
    let currentTextIndex: number | null = null;
    let doneReason = "stop";
    let toolCallCounter = 0;

    for await (const chunk of readNdjson(res.body)) {
      const c = chunk as { message?: { content?: string; tool_calls?: OllamaToolCall[] }; done?: boolean; done_reason?: string };
      if (c.done_reason) doneReason = c.done_reason;

      const content = c.message?.content;
      if (content) {
        e.onTextDelta(content);
        if (currentTextIndex !== null && blocks[currentTextIndex]?.type === "text") {
          (blocks[currentTextIndex] as { type: "text"; text: string }).text += content;
        } else {
          currentTextIndex = blocks.length;
          blocks.push({ type: "text", text: content });
        }
      }

      for (const call of c.message?.tool_calls ?? []) {
        const id = `ollama_call_${toolCallCounter++}`;
        e.onToolUseStart(id, call.function.name);
        currentTextIndex = null;
        blocks.push({ type: "tool_use", id, name: call.function.name, input: call.function.arguments ?? {} });
      }

      if (c.done) break;
    }

    return { blocks, stopReason: doneReason };
  }
}
