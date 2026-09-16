/**
 * The chat-history list (side panel, per PanelSection.tsx's anticipated
 * "session history" section): every persisted chat (assistant/history.ts),
 * newest first, open-on-click, delete-on-trash-click. Self-contained
 * fetch-on-mount + manual refresh, same pattern as ServersPanel.tsx —
 * `refreshKey` is bumped by App.tsx after every turn so titles/ordering stay
 * current without this panel needing to know anything about turns itself.
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import type { ChatSummary } from "../api";

export interface ChatHistoryPanelProps {
  activeChatId: string | null;
  refreshKey: number;
  onOpen: (id: string) => void;
  onDeletedActive: () => void;
}

function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function ChatHistoryPanel(props: ChatHistoryPanelProps) {
  const { activeChatId, refreshKey, onOpen, onDeletedActive } = props;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setChats(await api.listChats());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  async function handleDelete(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"? This can't be undone.`)) return;
    try {
      await api.deleteChat(id);
      await refresh();
      if (id === activeChatId) onDeletedActive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p className="assistant-history-error">{error}</p>;
  if (chats.length === 0) return <p className="assistant-history-empty">No saved chats yet — start typing below.</p>;

  return (
    <ul className="assistant-history-list">
      {chats.map((c) => (
        <li key={c.id} className={`assistant-history-item${c.id === activeChatId ? " assistant-history-item-active" : ""}`}>
          <button type="button" className="assistant-history-open" onClick={() => onOpen(c.id)} title={c.title}>
            <span className="assistant-history-title">{c.title}</span>
            <span className="assistant-history-date">{formatWhen(c.updatedAt)}</span>
          </button>
          <button
            type="button"
            className="assistant-history-delete"
            aria-label={`Delete chat "${c.title}"`}
            onClick={() => void handleDelete(c.id, c.title)}
          >
            🗑
          </button>
        </li>
      ))}
    </ul>
  );
}
