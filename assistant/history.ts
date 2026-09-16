/**
 * Chat history store, backed by Postgres (docker-compose.yml's `db`
 * service). This is the one deliberate exception to session.ts's "no
 * persistence" stance (D-12): that decision was about *live session state*
 * (widgets, approvals, in-flight turns) surviving a process restart, which
 * still isn't worth the complexity for a POC. Letting a user reopen
 * yesterday's conversation is a different, much more visible gap (every
 * comparable chat product has it) — and per the user's explicit ask, this
 * now lives in a real database with durable storage (a named Docker volume),
 * not loose files on disk.
 */
import pg from "pg";
import { logError } from "./log.js";
import type { LlmMessage } from "./llm/provider.js";

const { Pool } = pg;

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: LlmMessage[];
}

export type ChatSummary = Omit<ChatRecord, "messages">;

interface ChatRow {
  id: string;
  title: string;
  created_at: string; // BIGINT comes back as a string — Node numbers can't safely hold all int8 values.
  updated_at: string;
  messages?: LlmMessage[];
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

function toSummary(row: ChatRow): ChatSummary {
  return { id: row.id, title: row.title, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export class HistoryStore {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /** Called once at boot (main.ts) — a connection/permission failure here is fatal, not swallowed, since every other method assumes the table exists. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        messages JSONB NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON chats (updated_at DESC)`);
  }

  async list(): Promise<ChatSummary[]> {
    try {
      const { rows } = await this.pool.query<ChatRow>(`SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC`);
      return rows.map(toSummary);
    } catch (err) {
      logError("history:list", err);
      return [];
    }
  }

  async load(id: string): Promise<ChatRecord | undefined> {
    try {
      const { rows } = await this.pool.query<ChatRow>(`SELECT id, title, created_at, updated_at, messages FROM chats WHERE id = $1`, [id]);
      const row = rows[0];
      return row ? { ...toSummary(row), messages: row.messages ?? [] } : undefined;
    } catch (err) {
      logError("history:load", err);
      return undefined;
    }
  }

  /** No-op for an empty transcript — an untouched fresh chat never shows up in history. */
  async save(id: string, messages: LlmMessage[], createdAt: number): Promise<void> {
    if (messages.length === 0) return;
    try {
      // A single upsert (not read-then-write) avoids a lost-update race
      // between concurrent turns. `title`/`created_at` are only written on
      // the initial INSERT — the ON CONFLICT branch omits them from SET, so
      // a chat's title stays whatever its first message produced and its
      // created_at never moves.
      await this.pool.query(
        `INSERT INTO chats (id, title, created_at, updated_at, messages)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           updated_at = EXCLUDED.updated_at,
           messages = EXCLUDED.messages`,
        [id, deriveTitle(messages), createdAt, Date.now(), JSON.stringify(messages)],
      );
    } catch (err) {
      logError("history:save", err);
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      const result = await this.pool.query(`DELETE FROM chats WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      logError("history:remove", err);
      return false;
    }
  }
}
