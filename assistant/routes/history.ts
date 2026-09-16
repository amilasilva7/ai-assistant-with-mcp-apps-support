import { Router } from "express";
import type { HistoryStore } from "../history.js";
import type { SessionStore } from "../session.js";

export function createHistoryRouter(deps: { history: HistoryStore; sessions: SessionStore }): Router {
  const router = Router();

  router.get("/chats", (_req, res) => {
    res.json({ chats: deps.history.list() });
  });

  // Reopens a persisted chat: same id, prior messages restored into a fresh
  // in-memory Session (see session.ts's SessionStore.create for why widgets
  // and approvals do NOT come back). The chat id doubles as the session id
  // throughout, so the client's existing sessionId-keyed flows (chat, cancel,
  // approve) need no changes to work against a reopened chat.
  router.post("/chats/:id/open", (req, res) => {
    const record = deps.history.load(req.params.id);
    if (!record) {
      res.status(404).json({ error: "Unknown chat", code: "SESSION_NOT_FOUND" });
      return;
    }
    const session = deps.sessions.create({ id: record.id, messages: record.messages, createdAt: record.createdAt });
    res.json({ sessionId: session.id, title: record.title, messages: record.messages });
  });

  router.delete("/chats/:id", (req, res) => {
    const removed = deps.history.remove(req.params.id);
    deps.sessions.delete(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "Unknown chat", code: "SESSION_NOT_FOUND" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
