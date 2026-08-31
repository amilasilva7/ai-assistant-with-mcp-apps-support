/**
 * In-memory session store (design §4.2). No persistence (D-12): reload = a
 * fresh session, consistent with the "no database" stance.
 */
import type { LlmMessage } from "./llm/provider.js";
import type { ModelContextSnapshot, Session, WidgetBinding } from "./types.js";

const MAX_SESSIONS = 8;

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      createdAt: now,
      lastSeenAt: now,
      messages: [],
      widgets: new Map(),
      modelContext: new Map(),
      approvals: new Map(),
    };
    this.sessions.set(id, session);
    this.evictIfNeeded();
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session) session.lastSeenAt = Date.now();
    return session;
  }

  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    let oldest: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!oldest || s.lastSeenAt < oldest.lastSeenAt) oldest = s;
    }
    if (oldest) this.sessions.delete(oldest.id);
  }
}

function isPureUserTextMessage(m: LlmMessage): boolean {
  return m.role === "user" && m.content.every((b) => b.type === "text");
}

/**
 * Trims history to (approximately) the most recent `maxMessages` entries,
 * never orphaning a `tool_use` block from its `tool_result` (Anthropic
 * rejects that). A cut point is only safe immediately before a pure
 * user-text message, i.e. the start of a fresh turn — tool_result messages
 * always stay paired with the assistant message that requested them.
 */
export function trimHistory(messages: LlmMessage[], maxMessages: number): LlmMessage[] {
  if (messages.length <= maxMessages) return messages;
  const target = messages.length - maxMessages;
  for (let start = target; start < messages.length; start++) {
    if (isPureUserTextMessage(messages[start])) {
      return messages.slice(start);
    }
  }
  // No safe cut point in range — keep everything rather than corrupt the conversation.
  return messages;
}

export function newWidgetBinding(fields: Pick<WidgetBinding, "widgetInstanceId" | "serverId" | "toolName" | "resourceUri" | "trust">): WidgetBinding {
  return { ...fields, createdAt: Date.now(), alive: true, callCount: 0, callTimestamps: [] };
}

/** Drains pending widget model-context updates for still-alive widgets, newest first, capped. */
export function drainModelContext(session: Session, maxBlocks = 3): ModelContextSnapshot[] {
  const alive = [...session.modelContext.values()]
    .filter((snap) => session.widgets.get(snap.widgetInstanceId)?.alive)
    .sort((a, b) => b.at - a.at)
    .slice(0, maxBlocks);
  for (const snap of alive) session.modelContext.delete(snap.widgetInstanceId);
  return alive;
}
