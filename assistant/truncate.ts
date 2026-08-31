/**
 * Tool-result size guard (FR-B4 / OQ8 / design §5.6). Pure — no I/O, easy to
 * pin with a unit test.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface TruncatedResult {
  text: string;
  truncated: boolean;
  originalChars: number;
}

export function truncateToolResultForModel(result: CallToolResult, maxChars: number): TruncatedResult {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else {
      // Non-text blocks (image/audio/resource/resource_link) are not forwarded
      // to the model in v1 — the full block still reaches the widget via
      // sendToolResult. Closes review G-6's "non-text tool content" gap.
      parts.push(`[${block.type} content omitted]`);
    }
  }
  const text = parts.join("\n\n");

  let structuredPart = "";
  if (result.structuredContent !== undefined) {
    try {
      structuredPart = "\n\nstructuredContent:\n" + JSON.stringify(result.structuredContent);
    } catch {
      structuredPart = "\n\nstructuredContent: [unserializable]";
    }
  }

  const full = text + structuredPart;
  const originalChars = full.length;
  if (originalChars <= maxChars) {
    return { text: full, truncated: false, originalChars };
  }

  const marker = (omitted: number) =>
    `\n…[truncated: ${omitted} of ${originalChars} characters omitted; the rendered widget shows the full data]`;
  // Reserve room for the marker text itself (its length depends on the numbers
  // involved, but they are always small relative to maxChars).
  const budget = Math.max(0, maxChars - 140);

  if (text.length <= budget) {
    // structuredContent is what's pushing us over budget — trim it first.
    const keepStructuredChars = Math.max(0, budget - text.length);
    const kept = text + structuredPart.slice(0, keepStructuredChars);
    return { text: kept + marker(originalChars - kept.length), truncated: true, originalChars };
  }

  // Even the text alone exceeds budget: drop structuredContent, trim text.
  const kept = text.slice(0, budget);
  return { text: kept + marker(originalChars - kept.length), truncated: true, originalChars };
}
