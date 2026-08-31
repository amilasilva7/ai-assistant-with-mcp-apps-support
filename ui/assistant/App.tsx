/**
 * Root component (design §3.2's `App.tsx`): layout, session bootstrap
 * (`api.createSession()` once on mount, `api.getConfig()` for
 * `widgetInitTimeoutMs`/`buildWarnings`), and the global transcript state.
 *
 * Layout is a single chat column — text and widgets render together, inline,
 * in `Transcript.tsx`/`ToolResultCard.tsx` (no separate widget pane; see
 * ToolResultCard.tsx's header comment for why). The only other surface is the
 * "Panel" drawer for MCP server settings, which is unrelated to the chat
 * content and stays a slide-over so it never competes with it for space.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import * as api from "./api";
import { ChatConflictError } from "./api";
import { Composer } from "./components/Composer";
import { PanelSection } from "./components/PanelSection";
import { ServersPanel } from "./components/ServersPanel";
import { Transcript } from "./components/Transcript";
import type { ApprovalDecision } from "./state";
import { initialState, reducer } from "./state";

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
    }
  }

  function handleSubmit(text: string) {
    void runTurn(text, "user");
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
        <h1>income-mcp assistant</h1>
        <button type="button" className="assistant-panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
          {panelOpen ? "Hide panel ✕" : "Panel ☰"}
        </button>
      </header>
      {config && config.buildWarnings.length > 0 && (
        <div className="assistant-build-warning" role="status">
          {config.buildWarnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      <div className="assistant-body">
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
