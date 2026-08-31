/**
 * Hand-rolled markdown-subset renderer (T-9): bold, bullets, pipe tables,
 * paragraphs — the exact subset `server/format.ts` emits (plus a small,
 * additive underscore-italic rule, since `formatTrend` uses `_..._` for its
 * footnote). Renders React elements only, **never** `dangerouslySetInnerHTML`
 * — untrusted server text and untrusted model text never become HTML.
 */
import type { ReactNode } from "react";

type Block = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] } | { kind: "table"; header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.trim().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2).trim());
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.includes("|") && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("- ") && !(lines[i].includes("|") && isTableSeparator(lines[i + 1]))) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g).filter((p) => p !== "");
  if (parts.length === 0) return [text];
  return parts.map((part, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

export interface MiniMarkdownProps {
  text: string;
}

export function MiniMarkdown({ text }: MiniMarkdownProps) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className="assistant-markdown">
      {blocks.map((block, idx) => {
        const key = `block-${idx}`;
        if (block.kind === "paragraph") {
          return <p key={key}>{renderInline(block.text, key)}</p>;
        }
        if (block.kind === "list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIdx) => (
                <li key={`${key}-${itemIdx}`}>{renderInline(item, `${key}-${itemIdx}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <table key={key}>
            <thead>
              <tr>
                {block.header.map((cell, cellIdx) => (
                  <th key={`${key}-h-${cellIdx}`}>{renderInline(cell, `${key}-h-${cellIdx}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIdx) => (
                <tr key={`${key}-r-${rowIdx}`}>
                  {row.map((cell, cellIdx) => (
                    <td key={`${key}-r-${rowIdx}-${cellIdx}`}>{renderInline(cell, `${key}-r-${rowIdx}-${cellIdx}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
