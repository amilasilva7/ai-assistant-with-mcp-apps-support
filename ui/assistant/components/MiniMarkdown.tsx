/**
 * Hand-rolled markdown-subset renderer (T-9): bold, bullets, pipe tables,
 * paragraphs — the exact subset `server/format.ts` emits (plus a small,
 * additive underscore-italic rule, since `formatTrend` uses `_..._` for its
 * footnote). Renders React elements only, **never** `dangerouslySetInnerHTML`
 * — untrusted server text and untrusted model text never become HTML.
 *
 * The system prompt (see `assistant/loop.ts`) tells the model to stick to
 * "- " bullets only, but models don't always comply. List parsing is
 * intentionally lenient — "-", "*", "+", and "1." markers are all accepted
 * and indentation nests them — so a model that ignores the instruction still
 * degrades to a readable list instead of dumping raw "*"/"+"/"1." characters
 * into the bubble.
 */
import type { ReactNode } from "react";

interface ListItemNode {
  text: string;
  children?: { ordered: boolean; items: ListItemNode[] };
}

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: ListItemNode[] }
  | { kind: "table"; header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

interface ListToken {
  indent: number;
  ordered: boolean;
  text: string;
}

const LIST_LINE_RE = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.+)$/;

function parseListLine(line: string): ListToken | null {
  const m = LIST_LINE_RE.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: m[3] !== undefined, text: m[4] };
}

function buildListLevel(tokens: ListToken[], start: number, indent: number): { items: ListItemNode[]; ordered: boolean; next: number } {
  const items: ListItemNode[] = [];
  const ordered = tokens[start].ordered;
  let i = start;
  while (i < tokens.length && tokens[i].indent === indent) {
    const text = tokens[i].text;
    i++;
    let children: ListItemNode["children"];
    if (i < tokens.length && tokens[i].indent > indent) {
      const sub = buildListLevel(tokens, i, tokens[i].indent);
      children = { ordered: sub.ordered, items: sub.items };
      i = sub.next;
    }
    items.push({ text, children });
  }
  return { items, ordered, next: i };
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
    if (parseListLine(line)) {
      const tokens: ListToken[] = [];
      while (i < lines.length) {
        const tok = parseListLine(lines[i]);
        if (tok) {
          tokens.push(tok);
          i++;
          continue;
        }
        if (lines[i].trim() === "") {
          let j = i;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j < lines.length && parseListLine(lines[j])) {
            i = j;
            continue;
          }
        }
        break;
      }
      const { items, ordered } = buildListLevel(tokens, 0, tokens[0].indent);
      blocks.push({ kind: "list", ordered, items });
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
    while (i < lines.length && lines[i].trim() !== "" && !parseListLine(lines[i]) && !(lines[i].includes("|") && isTableSeparator(lines[i + 1]))) {
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

function renderList(ordered: boolean, items: ListItemNode[], keyPrefix: string): ReactNode {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag key={keyPrefix}>
      {items.map((item, itemIdx) => {
        const key = `${keyPrefix}-${itemIdx}`;
        return (
          <li key={key}>
            {renderInline(item.text, key)}
            {item.children && renderList(item.children.ordered, item.children.items, `${key}-c`)}
          </li>
        );
      })}
    </Tag>
  );
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
          return renderList(block.ordered, block.items, key);
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
