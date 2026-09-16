/**
 * The visible "Thinking… / Talking to <server>… / Rethinking…" row shown
 * while the model is working but hasn't produced anything to look at yet
 * (design intent: the same real-time status ChatGPT/Claude-style UIs show
 * between a prompt and the first token, and again between a tool result and
 * the model's reaction to it). `state.ts`'s `liveStatus` already carries the
 * right label for every phase — this just renders it visibly instead of the
 * screen-reader-only `assistant-live-status` region, and only for the
 * stretches where no assistant text is actively streaming (once text starts,
 * the streaming bubble itself is the feedback).
 *
 * Purely decorative: `aria-hidden` because Transcript.tsx's existing
 * `assistant-live-status` region already announces the same text via
 * `aria-live="polite"` — without this, a screen reader would hear every
 * status change twice.
 */
export interface StatusIndicatorProps {
  label: string;
}

export function StatusIndicator({ label }: StatusIndicatorProps) {
  return (
    <div className="assistant-status-indicator" aria-hidden="true">
      <span className="assistant-status-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="assistant-status-label">{label}</span>
    </div>
  );
}
