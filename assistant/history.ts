/**
 * File-based chat history store — one JSON file per chat under
 * assistant/data/chats/. This is the one deliberate exception to session.ts's
 * "no persistence" stance (D-12): that decision was about *live session
 * state* (widgets, approvals, in-flight turns) surviving a process restart,
 * which still isn't worth the complexity for a POC. Letting a user reopen
 * yesterday's conversation is a different, much more visible gap (every
 * comparable chat product has it), and a flat JSON-per-chat store gets there
 * without introducing an actual database.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logError } from "./log.js";
import type { LlmMessage } from "./llm/provider.js";

const ROOT_DIR = path.join(import.meta.dirname, "..");
const CHATS_DIR = path.join(ROOT_DIR, "data", "chats");

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: LlmMessage[];
}

export type ChatSummary = Omit<ChatRecord, "messages">;

function chatPath(id: string): string {
  // crypto.randomUUID() is always the id's source (session.ts), so this never
  // sees attacker-controlled input, but the check costs nothing and rules out
  // path traversal outright rather than trusting that invariant forever.
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid chat id");
  return path.join(CHATS_DIR, `${id}.json`);
}

/**
 * The first user message's content can start with widget-context banners
 * (session.ts/loop.ts's `[widget state — ...]` blocks) injected ahead of
 * what the user actually typed — those make a useless, cryptic title, so the
 * *last* text block of the first user message is used instead (the banners
 * are always prepended, never appended; see loop.ts's `contextBlocks`).
 */
function deriveTitle(messages: LlmMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const textBlocks = firstUser?.content.filter((b) => b.type === "text") ?? [];
  const text = textBlocks.at(-1)?.text?.trim().replace(/\s+/g, " ");
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export class HistoryStore {
  constructor() {
    mkdirSync(CHATS_DIR, { recursive: true });
  }

  list(): ChatSummary[] {
    let files: string[];
    try {
      files = readdirSync(CHATS_DIR).filter((f) => f.endsWith(".json"));
    } catch (err) {
      logError("history:list", err);
      return [];
    }
    const summaries: ChatSummary[] = [];
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(path.join(CHATS_DIR, file), "utf-8")) as ChatRecord;
        summaries.push({ id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt });
      } catch (err) {
        logError("history:list", err);
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  load(id: string): ChatRecord | undefined {
    try {
      return JSON.parse(readFileSync(chatPath(id), "utf-8")) as ChatRecord;
    } catch {
      return undefined;
    }
  }

  /** No-op for an empty transcript — an untouched fresh chat never shows up in history. */
  save(id: string, messages: LlmMessage[], createdAt: number): void {
    if (messages.length === 0) return;
    const existing = this.load(id);
    const record: ChatRecord = {
      id,
      title: existing?.title ?? deriveTitle(messages),
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: Date.now(),
      messages,
    };
    try {
      writeFileSync(chatPath(id), JSON.stringify(record), "utf-8");
    } catch (err) {
      logError("history:save", err);
    }
  }

  remove(id: string): boolean {
    const p = chatPath(id);
    if (!existsSync(p)) return false;
    try {
      unlinkSync(p);
      return true;
    } catch (err) {
      logError("history:remove", err);
      return false;
    }
  }
}
