import { Router } from "express";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import { runTurn, resolveApproval } from "../loop.js";
import type { ServerRegistry } from "../registry.js";
import type { SessionStore } from "../session.js";
import type { ApprovalDecision } from "../types.js";
import type { TurnEvent } from "../turnEvents.js";

export function createChatRouter(deps: { sessions: SessionStore; registry: ServerRegistry; llm: LlmProvider; config: Config }): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const { sessionId, prompt, source } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof prompt !== "string") {
      res.status(400).json({ error: "sessionId and prompt are required", code: "CONFIG_INVALID" });
      return;
    }
    const session = deps.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Unknown session", code: "SESSION_NOT_FOUND" });
      return;
    }
    if (prompt.trim() === "") {
      res.status(400).json({ error: "Prompt is empty", code: "CONFIG_INVALID" });
      return;
    }

    // G-e concurrency policy (explicit decision, design left this open):
    // reject a second concurrent turn for the same session with 409 rather
    // than queueing it. This is the same route a widget's `ui/message`
    // (source:"app") goes through, so it is gated identically.
    if (session.activeTurn) {
      res.status(409).json({ error: "A turn is already active for this session.", code: "RATE_LIMITED" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    const emit = (e: TurnEvent) => {
      res.write(JSON.stringify(e) + "\n");
    };

    // `res.on("close")`, not `req.on("close")`: the request stream closes as
    // soon as its body has been fully read (well before the response is
    // done), which aborted every turn within milliseconds. `res` only closes
    // when the underlying connection actually goes away — mirroring the
    // pattern already used in server/main.ts:32-35.
    res.on("close", () => {
      session.activeTurn?.abort.abort();
    });

    const turnId = crypto.randomUUID();
    try {
      await runTurn({
        session,
        registry: deps.registry,
        llm: deps.llm,
        config: deps.config,
        prompt,
        turnId,
        emit,
      });
    } catch (err) {
      // runTurn is designed to never throw, but this is the last line of
      // defense so a bug there cannot crash the process (NFR-Reliability-1).
      emit({ t: "error", code: "LLM_ERROR", message: err instanceof Error ? err.message : String(err) });
      emit({ t: "turn_end", stopReason: "error", iterations: 0 });
    }
    res.end();
    void source; // source is informational only; both paths share the same policy above.
  });

  router.post("/chat/cancel", (req, res) => {
    const { sessionId } = req.body ?? {};
    const session = typeof sessionId === "string" ? deps.sessions.get(sessionId) : undefined;
    if (!session?.activeTurn) {
      res.json({ cancelled: false });
      return;
    }
    session.activeTurn.abort.abort();
    res.json({ cancelled: true });
  });

  router.post("/chat/approve", (req, res) => {
    const { sessionId, callId, decision } = req.body ?? {};
    const session = typeof sessionId === "string" ? deps.sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: "Unknown session", code: "SESSION_NOT_FOUND" });
      return;
    }
    const validDecisions: ApprovalDecision[] = ["once", "session", "deny"];
    if (!validDecisions.includes(decision)) {
      res.status(400).json({ error: "decision must be once|session|deny" });
      return;
    }
    resolveApproval(session, callId, decision as ApprovalDecision);
    res.json({ ok: true });
  });

  return router;
}
