/**
 * Message list: text and tool-call cards (with their widgets inline — see
 * ToolResultCard.tsx) in one continuous scroll, the way a chat transcript
 * reads in ChatGPT/Claude. An `aria-live="polite"` region carries assistant
 * status for screen readers (NFR-Accessibility-1).
 *
 * Auto-scrolls to the newest content as it streams in, but only while the
 * user is already near the bottom — scrolling up to reread earlier messages
 * is never yanked back down mid-stream.
 */
import { useEffect, useRef } from "react";
import type { ApprovalDecision, TranscriptItem } from "../state";
import { ErrorMessage } from "./ErrorMessage";
import { MiniMarkdown } from "./MiniMarkdown";
import { ToolResultCard } from "./ToolResultCard";

const SUGGESTIONS = [
  "Search for available health insurance products",
  "Filter only family type health insurance products",
  "Get Full product details of Family IncomeShield basic products",
  "Compare Family basic and family classic products",
];

const AUTO_SCROLL_THRESHOLD_PX = 120;

export interface TranscriptProps {
  items: TranscriptItem[];
  liveStatus: string;
  sessionId: string | null;
  widgetInitTimeoutMs: number;
  onApprove: (callId: string, decision: ApprovalDecision) => void;
  onWidgetMessage: (callId: string, text: string) => void;
  onHostNotice: (level: "info" | "warn", message: string) => void;
  onSuggestion: (text: string) => void;
}

export function Transcript(props: TranscriptProps) {
  const { items, liveStatus, sessionId, widgetInitTimeoutMs, onApprove, onWidgetMessage, onHostNotice, onSuggestion } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Sets scrollTop directly on the transcript pane itself, rather than
  // `bottomRef.current?.scrollIntoView(...)` — scrollIntoView walks up to
  // whichever ancestor is actually scrollable, and if a layout bug ever lets
  // the page grow instead of this pane (see the .assistant-transcript
  // min-height comment in theme.css), it would silently start scrolling the
  // whole page — composer included — on every streamed token instead of
  // failing loudly. Targeting this element directly can't do that.
  useEffect(() => {
    if (stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  return (
    <div className="assistant-transcript" ref={scrollRef}>
      {items.length === 0 && (
        <div className="assistant-empty-state">
          <p>Ask about health insurance plans — search, filter, compare, or get a quotation.</p>
          <div className="assistant-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="assistant-suggestion-chip" onClick={() => onSuggestion(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <ul className="assistant-transcript-list">
        {items.map((item) => (
          <li key={item.id} className={`assistant-item assistant-item-${item.kind}`}>
            {item.kind === "user" && (
              <div className={`assistant-bubble assistant-bubble-user${item.source === "app" ? " assistant-bubble-app" : ""}`}>
                {item.source === "app" && <div className="assistant-bubble-label">From widget</div>}
                <p>{item.text}</p>
              </div>
            )}
            {item.kind === "assistant_text" && (
              <div className="assistant-bubble assistant-bubble-assistant">
                <MiniMarkdown text={item.text} />
                {item.streaming && <span className="assistant-cursor" aria-hidden="true" />}
              </div>
            )}
            {item.kind === "tool_call" && (
              <ToolResultCard
                item={item}
                sessionId={sessionId}
                widgetInitTimeoutMs={widgetInitTimeoutMs}
                onApprove={onApprove}
                onWidgetMessage={onWidgetMessage}
                onHostNotice={onHostNotice}
              />
            )}
            {item.kind === "notice" && (
              <div className={`assistant-notice assistant-notice-${item.level}`} role="status">
                {item.message}
              </div>
            )}
            {item.kind === "error" && <ErrorMessage code={item.code} message={item.message} />}
          </li>
        ))}
      </ul>
      <div className="assistant-live-status" aria-live="polite">
        {liveStatus}
      </div>
    </div>
  );
}
