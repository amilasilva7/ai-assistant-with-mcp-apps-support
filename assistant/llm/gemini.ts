/**
 * Gemini implementation of the `LlmProvider` seam (design D-3/T-3): a second
 * provider added without touching the loop, the registry, or the UI. Added
 * as a temporary stand-in for Anthropic (e.g. while a Claude account is out
 * of credits) — see ASSISTANT_LLM_PROVIDER in .env.example.
 *
 * Uses the REST `streamGenerateContent` endpoint directly (no SDK dependency
 * added) — request/response shapes verified against the current Gemini API
 * reference and the "Function calling with the Gemini API (Legacy)" guide:
 *   - auth: `x-goog-api-key` header
 *   - tools: `[{ functionDeclarations: [{name, description, parameters}] }]`
 *   - a function result is sent back as `{role:"user", parts:[{functionResponse:{name,id,response}}]}`
 *     (the "user" role here is Gemini's convention, not a real end-user turn)
 *   - streamed chunks: `data: {"candidates":[{"content":{"parts":[...]}}]}` (SSE)
 */
import type { LlmAssistantBlock, LlmMessage, LlmProvider, LlmToolDef, LlmUserBlock, StreamTurnArgs, StreamTurnEvents, StreamTurnResult } from "./provider.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiApiError extends Error {
  constructor(
    public status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

// Keys Gemini's OpenAPI-subset schema validator is known not to accept;
// stripped defensively rather than building a real JSON-Schema translator
// (design T-3's rationale: a full translator is the biggest bug source in a
// multi-provider tool bridge, and is out of scope for a temporary provider).
const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "additionalProperties", "default"]);

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return node;
}

function toFunctionDeclaration(t: LlmToolDef) {
  return { name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) };
}

/**
 * Gemini's functionResponse part requires the original function *name*
 * (design's provider-neutral `LlmUserBlock` only carries `toolUseId`,
 * because Anthropic's tool_result correlates by id alone) — so the id->name
 * mapping is recovered from the assistant `tool_use` blocks already present
 * earlier in the same conversation before any content is converted.
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

function toGeminiContent(m: LlmMessage, toolNames: Map<string, string>, thoughtSignatures: Map<string, string>): GeminiContent {
  if (m.role === "user") {
    return { role: "user", parts: m.content.map((b) => toGeminiUserPart(b, toolNames)) };
  }
  return {
    role: "model",
    parts: m.content.map((b): GeminiPart => {
      if (b.type === "text") return { text: b.text };
      const signature = thoughtSignatures.get(b.id);
      return { functionCall: { id: b.id, name: b.name, args: b.input }, ...(signature ? { thoughtSignature: signature } : {}) };
    }),
  };
}

function toGeminiUserPart(b: LlmUserBlock, toolNames: Map<string, string>): GeminiPart {
  if (b.type === "text") return { text: b.text };
  // Gemini has no `isError` flag on functionResponse; fold it into the
  // payload text so the model still sees the failure.
  const name = toolNames.get(b.toolUseId) ?? b.toolUseId;
  return { functionResponse: { id: b.toolUseId, name, response: { result: b.isError ? `ERROR: ${b.text}` : b.text } } };
}

async function* readSseJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Google's SSE responses use CRLF ("\r\n\r\n" event separators, "\r\n"
    // line separators) rather than the bare "\n" this repo's other NDJSON/SSE
    // readers assume (see ui/assistant/api.ts's streamChat) — normalize once
    // here rather than special-casing every split below.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // Ignore a malformed line rather than aborting the whole stream.
      }
    }
  }
}

export class GeminiProvider implements LlmProvider {
  // Gemini 3's reasoning models attach a `thoughtSignature` to each
  // functionCall part and reject a later turn that echoes that call back
  // without it ("Function call is missing a thought_signature..."). The
  // provider-neutral `LlmAssistantBlock` (design's Anthropic-shaped seam,
  // provider.ts) has no field for it, so it's cached here — instance-scoped,
  // keyed by the same call id used as `tool_use.id`/`toolUseId` everywhere
  // else in the loop — and replayed when that block is sent back on a later
  // turn. Bounded in practice by the session store's history trimming
  // (assistant/session.ts), not capped explicitly.
  private thoughtSignatures = new Map<string, string>();

  constructor(
    private apiKey: string,
    private model: string,
    private maxOutputTokens: number,
  ) {}

  async streamTurn(a: StreamTurnArgs, e: StreamTurnEvents): Promise<StreamTurnResult> {
    const toolNames = buildToolNameMap(a.messages);
    const body = {
      systemInstruction: { parts: [{ text: a.system }] },
      contents: a.messages.map((m) => toGeminiContent(m, toolNames, this.thoughtSignatures)),
      tools: a.tools.length > 0 ? [{ functionDeclarations: a.tools.map(toFunctionDeclaration) }] : undefined,
      generationConfig: { maxOutputTokens: this.maxOutputTokens },
    };

    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: a.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new GeminiApiError(res.status, text);
    }

    const blocks: LlmAssistantBlock[] = [];
    let currentTextIndex: number | null = null;
    let finishReason = "STOP";
    const announcedToolIds = new Set<string>();

    for await (const chunk of readSseJsonLines(res.body)) {
      const c = chunk as { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>; promptFeedback?: { blockReason?: string } };
      if (c.promptFeedback?.blockReason) {
        throw new GeminiApiError(undefined, `Gemini blocked the request: ${c.promptFeedback.blockReason}`);
      }
      const candidate = c.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;

      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text !== "") {
          e.onTextDelta(part.text);
          if (currentTextIndex !== null && blocks[currentTextIndex]?.type === "text") {
            (blocks[currentTextIndex] as { type: "text"; text: string }).text += part.text;
          } else {
            currentTextIndex = blocks.length;
            blocks.push({ type: "text", text: part.text });
          }
        } else if (part.functionCall) {
          const id = part.functionCall.id ?? `${part.functionCall.name}_${blocks.length}`;
          if (!announcedToolIds.has(id)) {
            announcedToolIds.add(id);
            e.onToolUseStart(id, part.functionCall.name);
          }
          if (part.thoughtSignature) this.thoughtSignatures.set(id, part.thoughtSignature);
          currentTextIndex = null;
          blocks.push({ type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
        }
      }
    }

    return { blocks, stopReason: finishReason };
  }
}
