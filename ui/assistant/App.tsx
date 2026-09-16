/**
 * Root component (design §3.2's `App.tsx`): layout, session bootstrap
 * (`api.createSession()` once on mount, `api.getConfig()` for
 * `widgetInitTimeoutMs`/`buildWarnings`), and the global transcript state.
 *
 * Layout is a single chat column — text and widgets render together, inline,
 * in `Transcript.tsx`/`ToolResultCard.tsx` (no separate widget pane; see
 * ToolResultCard.tsx's header comment for why). Two side surfaces flank it:
 * a left chat-history sidebar (ChatGPT/Claude-style — always visible as an
 * in-flow column on desktop, default-collapsed and overlaying on narrow
 * viewports, see the media query in theme.css) and the right "Panel" drawer
 * for MCP server settings, unrelated to chat content, which stays a
 * slide-over always so it never competes with it for space.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import * as api from "./api";
import { ChatConflictError } from "./api";
import { ChatHistoryPanel } from "./components/ChatHistoryPanel";
import { Composer } from "./components/Composer";
import { ModelSwitcher } from "./components/ModelSwitcher";
import { PanelSection } from "./components/PanelSection";
import { ServersPanel } from "./components/ServersPanel";
import { Transcript } from "./components/Transcript";
import type { ApprovalDecision } from "./state";
import { initialState, messagesToTranscript, reducer } from "./state";

interface AssistantConfig {
  model: string;
  widgetInitTimeoutMs: number;
  maxToolIterations: number;
  buildWarnings: string[];
}

// Widgets initiate follow-up turns via `ui/message` (design §5.3's `onmessage`
// handler in host/bridge.ts); this is the host-side half of that contract —
// rate-limited per widget instance so a misbehaving widget cannot spam turns.
const WIDGET_MESSAGE_MIN_INTERVAL_MS = 2000;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Default open on desktop, default collapsed on narrow viewports (a
  // permanently-open sidebar would eat most of the screen on a phone) — a
  // one-time check at mount, not a live resize listener, matching the
  // simplicity level of the rest of this app's layout state.
  const [historyOpen, setHistoryOpen] = useState(() => !window.matchMedia("(max-width: 640px)").matches);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const lastWidgetMessageAt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sid, cfg] = await Promise.all([api.createSession(), api.getConfig()]);
        if (cancelled) return;
        setSessionId(sid);
        setConfig(cfg);
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runTurn(text: string, source: "user" | "app") {
    if (!sessionId || state.turnActive) return;
    dispatch({ type: "submit_prompt", text, source });
    try {
      await api.streamChat(sessionId, text, source, (event) => dispatch({ type: "turn_event", event }));
    } catch (err) {
      const message = err instanceof ChatConflictError ? err.message : err instanceof Error ? err.message : String(err);
      dispatch({ type: "turn_failed", message });
    } finally {
      // The backend persists this chat's history on every turn end
      // (routes/chat.ts), success or not — bump the panel's refresh key so
      // its title/position catches up without it having to know about turns.
      setHistoryRefreshKey((k) => k + 1);
    }
  }

  function handleSubmit(text: string) {
    void runTurn(text, "user");
  }

  async function handleNewChat() {
    if (state.turnActive) return;
    try {
      const sid = await api.createSession();
      setSessionId(sid);
      dispatch({ type: "reset" });
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpenChat(id: string) {
    if (state.turnActive) return;
    try {
      const { sessionId: sid, messages } = await api.openChat(id);
      setSessionId(sid);
      dispatch({ type: "load_chat", items: messagesToTranscript(messages) });
      // Only the overlay-on-mobile case needs this — desktop's in-flow
      // column has no reason to close itself after a selection.
      if (window.matchMedia("(max-width: 640px)").matches) setHistoryOpen(false);
    } catch (err) {
      dispatch({ type: "turn_failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleCancel() {
    if (sessionId) void api.cancelChat(sessionId);
  }

  function handleApprove(callId: string, decision: ApprovalDecision) {
    if (sessionId) void api.approveToolCall(sessionId, callId, decision);
  }

  function handleWidgetMessage(callId: string, text: string) {
    const now = Date.now();
    const last = lastWidgetMessageAt.current.get(callId) ?? 0;
    if (now - last < WIDGET_MESSAGE_MIN_INTERVAL_MS) return;
    lastWidgetMessageAt.current.set(callId, now);
    void runTurn(text, "app");
  }

  function handleHostNotice(level: "info" | "warn", message: string) {
    dispatch({ type: "host_notice", level, message });
  }

  if (bootError) {
    return (
      <div className="assistant-boot-error">
        <h1>income-mcp assistant</h1>
        <p>Could not start a session: {bootError}</p>
      </div>
    );
  }

  return (
    <div className="assistant-shell">
      <header className="assistant-header">
        <div className="assistant-header-start">
          <button
            type="button"
            className="assistant-history-toggle"
            aria-expanded={historyOpen}
            aria-label={historyOpen ? "Collapse chat history" : "Expand chat history"}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            ☰
          </button>
          <h1>income-mcp assistant</h1>
        </div>
        <div className="assistant-header-actions">
          <button type="button" className="assistant-panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "Hide panel ✕" : "Servers ☰"}
          </button>
        </div>
      </header>
      {config && config.buildWarnings.length > 0 && (
        <div className="assistant-build-warning" role="status">
          {config.buildWarnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      <div className="assistant-body">
        {historyOpen && (
          // Backdrop only intercepts clicks on narrow viewports (CSS hides
          // it above 640px, where the sidebar is an in-flow column rather
          // than an overlay) — see .assistant-history-backdrop in theme.css.
          <div className="assistant-history-backdrop" onClick={() => setHistoryOpen(false)} />
        )}
        <aside className={`assistant-history-sidebar${historyOpen ? "" : " assistant-history-sidebar-collapsed"}`}>
          <div className="assistant-history-sidebar-header">
            <button
              type="button"
              className="assistant-history-collapse"
              aria-label="Collapse chat history"
              onClick={() => setHistoryOpen(false)}
            >
              ‹
            </button>
            <button type="button" className="assistant-new-chat-button" disabled={state.turnActive} onClick={() => void handleNewChat()}>
              + New chat
            </button>
          </div>
          <div className="assistant-history-sidebar-body">
            <ChatHistoryPanel activeChatId={sessionId} refreshKey={historyRefreshKey} onOpen={handleOpenChat} onDeletedActive={handleNewChat} />
          </div>
        </aside>
        <main className="assistant-main">
          <Transcript
            items={state.transcript}
            liveStatus={state.liveStatus}
            sessionId={sessionId}
            widgetInitTimeoutMs={config?.widgetInitTimeoutMs ?? 5000}
            onApprove={handleApprove}
            onWidgetMessage={handleWidgetMessage}
            onHostNotice={handleHostNotice}
            onSuggestion={handleSubmit}
          />
          <Composer disabled={!sessionId || state.turnActive} turnActive={state.turnActive} onSubmit={handleSubmit} onCancel={handleCancel} />
          <ModelSwitcher />
        </main>

        {panelOpen && (
          <>
            {/* Backdrop: click-outside-to-close on narrow viewports where the
                drawer overlays the chat instead of sitting beside it. */}
            <div className="assistant-sidebar-backdrop" onClick={() => setPanelOpen(false)} />
            <aside className="assistant-sidebar">
              {/* Future features are added here as sibling PanelSections. */}
              <PanelSection title="MCP servers">
                <ServersPanel />
              </PanelSection>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
