/**
 * The transcript's tool-call card: status chip, approval prompt, the widget
 * (when one exists), and the text summary — all in one card, inline in the
 * chat flow. Previously the widget rendered separately in a pinned side pane
 * (`WidgetPane.tsx`, now removed) while this card only held a "View chart"
 * link; that split read as two disconnected answers side by side instead of
 * one chat message, which is exactly the confusion a ChatGPT/Claude-style
 * conversation avoids by keeping an answer's text and its chart/artifact
 * together, in the order they were produced. This card is the fix: the chart
 * mounts right here, and the raw text/table (`server/format.ts`'s markdown)
 * collapses under a "Show data" disclosure once a chart is showing — still in
 * the DOM for screen readers and for when there's no chart, just not
 * competing with it visually (design D-4's rationale, applied inline).
 */
import { useState } from "react";
import type { ContentBlockLike } from "../api";
import { WidgetFrame } from "../host/WidgetFrame";
import type { ApprovalDecision, ToolCallItem } from "../state";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { MiniMarkdown } from "./MiniMarkdown";

export interface ToolResultCardProps {
  item: ToolCallItem;
  sessionId: string | null;
  widgetInitTimeoutMs: number;
  onApprove: (callId: string, decision: ApprovalDecision) => void;
  onWidgetMessage: (callId: string, text: string) => void;
  onHostNotice: (level: "info" | "warn", message: string) => void;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function extractText(content: ContentBlockLike[] | undefined): string {
  if (!content) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

export function ToolResultCard(props: ToolResultCardProps) {
  const { item, sessionId, widgetInitTimeoutMs, onApprove, onWidgetMessage, onHostNotice } = props;
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  function retryWidget() {
    setFallbackReason(null);
    setMounted(false);
    setRetryToken((t) => t + 1);
  }

  const attemptWidget = Boolean(item.resourceUri) && !item.widgetUnavailable && !fallbackReason && Boolean(sessionId);

  const summaryText = item.error
    ? item.error.message
    : item.result
      ? extractText(item.result.content) || "(no text content)"
      : item.approvalPending
        ? "Waiting for approval…"
        : item.cancelled
          ? "This tool call was cancelled before it finished."
          : "Running…";

  const statusParts = [`${item.serverName} · ${item.toolName}`];
  if (item.result) statusParts.push(formatDuration(item.result.durationMs));
  if (item.error) statusParts.push(formatDuration(item.error.durationMs));
  if (item.result?.truncated) statusParts.push("trimmed for the model");
  if (item.result?.isError) statusParts.push("tool reported an error");
  if (item.trust === "user") statusParts.push("user-added server");

  return (
    <div className="assistant-tool-card">
      <div className="assistant-tool-status">
        <span className="assistant-tool-status-chip">{statusParts.join(" · ")}</span>
        {item.cancelled && <span className="assistant-tool-status-cancelled">cancelled</span>}
      </div>

      {item.approvalPending && <ApprovalPrompt serverName={item.serverName} toolName={item.toolName} onDecision={(decision) => onApprove(item.callId, decision)} />}

      {item.widgetUnavailable && (
        <div className="assistant-notice assistant-notice-warn">Widget bundle not built for this tool — run "npm run build". Showing text only.</div>
      )}

      {attemptWidget && sessionId && (
        <div className="assistant-tool-widget">
          {!mounted && <div className="assistant-widget-loading">Rendering chart…</div>}
          <div className={mounted ? "assistant-widget-frame" : "assistant-widget-frame assistant-widget-frame-loading"}>
            <WidgetFrame
              key={retryToken}
              sessionId={sessionId}
              callId={item.callId}
              trust={item.trust}
              mountable={item.mountable}
              widgetInitTimeoutMs={widgetInitTimeoutMs}
              input={item.input}
              result={item.result ? { content: item.result.content, structuredContent: item.result.structuredContent, isError: item.result.isError } : undefined}
              cancelled={item.cancelled}
              onFallback={setFallbackReason}
              onMounted={() => setMounted(true)}
              onWidgetMessage={(text) => onWidgetMessage(item.callId, text)}
              onOpenLinkNotice={(message) => onHostNotice("warn", message)}
            />
          </div>
        </div>
      )}

      {fallbackReason && (
        <div className="assistant-notice assistant-notice-warn">
          Widget could not be shown ({fallbackReason}). See the details below.{" "}
          <button type="button" className="assistant-retry-widget" onClick={retryWidget}>
            Retry widget
          </button>
        </div>
      )}

      {attemptWidget ? (
        <details className="assistant-tool-details">
          <summary>Show data</summary>
          <div className="assistant-text-summary-body">
            <MiniMarkdown text={summaryText} />
          </div>
        </details>
      ) : (
        <div className="assistant-text-summary-body">
          <MiniMarkdown text={summaryText} />
        </div>
      )}
    </div>
  );
}
