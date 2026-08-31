/**
 * Iframe lifecycle: mount, bridge connect, queue, size, teardown (design
 * §3.2's `host/WidgetFrame.tsx`).
 *
 * Two review corrections are load-bearing here:
 *  - R-3 (handshake ordering): the iframe is always rendered (attached to
 *    the DOM) so `iframe.contentWindow` exists, but `srcdoc` is only ever
 *    set *after* `await bridge.connect(transport)` resolves — setting it
 *    earlier would drop the view's `ui/initialize` message because the
 *    transport's message listener (attached inside `connect()`) would not
 *    exist yet.
 *  - R-2 (approval-before-mount): the whole mount sequence below is gated
 *    on the `mountable` prop, which the transcript only flips to `true`
 *    once a `trust:"user"` tool call has been approved (or immediately, for
 *    `trust:"builtin"`). Until then the iframe stays blank.
 *
 * Note (G-a, stated per review, not a bug): because the widget document
 * runs in a sandboxed iframe with an opaque origin and `connect-src 'none'`,
 * the host has no way to observe the guest's own runtime CSP violations
 * (`securitypolicyviolation` fires inside the guest and cannot be reported
 * out). FR-D3's literal "surfaces a rendering error" acceptance criterion is
 * therefore only verifiable via the browser's own devtools during manual
 * testing (§12.3), not by this host. What the host *can* and does observe
 * (and fall back on) is covered by §11.2: resource-read failures, the init
 * timeout, transport close, and repeated `oncalltool` failures.
 */
import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import * as api from "../api";
import type { ContentBlockLike, Trust } from "../api";
import { HOST_INFO, hostCapabilities, registerHandlers } from "./bridge";
import { currentTheme, initialHostContext } from "./hostContext";
import { buildWidgetAllow, buildWidgetCsp, injectWidgetPreamble, WIDGET_SANDBOX } from "./sandbox";

export interface WidgetResult {
  content: ContentBlockLike[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface WidgetFrameProps {
  sessionId: string;
  callId: string;
  trust: Trust;
  mountable: boolean;
  widgetInitTimeoutMs: number;
  input?: Record<string, unknown>;
  result?: WidgetResult;
  cancelled?: boolean;
  onFallback: (reason: string) => void;
  onMounted: () => void;
  onWidgetMessage: (text: string) => void;
  onOpenLinkNotice: (message: string) => void;
}

export function WidgetFrame(props: WidgetFrameProps) {
  const { sessionId, callId, trust, mountable, widgetInitTimeoutMs } = props;
  const [phase, setPhase] = useState<"idle" | "connecting" | "mounted" | "failed">("idle");
  const [height, setHeight] = useState(360);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const startedRef = useRef(false);
  const sentInputRef = useRef(false);
  const sentResultRef = useRef(false);
  const sentCancelledRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const lastHeightRef = useRef(360);

  const onFallbackRef = useRef(props.onFallback);
  onFallbackRef.current = props.onFallback;
  const onMountedRef = useRef(props.onMounted);
  onMountedRef.current = props.onMounted;
  const onWidgetMessageRef = useRef(props.onWidgetMessage);
  onWidgetMessageRef.current = props.onWidgetMessage;
  const onOpenLinkNoticeRef = useRef(props.onOpenLinkNotice);
  onOpenLinkNoticeRef.current = props.onOpenLinkNotice;

  useEffect(() => {
    if (!mountable || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    let initTimer: number | undefined;

    async function mount() {
      setPhase("connecting");
      const iframeEl = iframeRef.current;
      if (!iframeEl) {
        onFallbackRef.current("iframe not attached");
        return;
      }
      // R-3 step 2: capture contentWindow (only valid once the iframe is in the DOM).
      const contentWindow = iframeEl.contentWindow;
      if (!contentWindow) {
        onFallbackRef.current("iframe.contentWindow unavailable");
        return;
      }

      const bridge = new AppBridge(null, HOST_INFO, hostCapabilities(), {
        hostContext: initialHostContext({ widthPx: iframeEl.clientWidth || 400, theme: currentTheme() }),
      });
      bridgeRef.current = bridge;

      registerHandlers(bridge, {
        sessionId,
        widgetInstanceId: callId,
        onSizeChange: (h) => {
          if (h === undefined) return;
          if (Math.abs(h - lastHeightRef.current) < 4) return;
          lastHeightRef.current = h;
          requestAnimationFrame(() => setHeight(Math.min(720, Math.max(160, h))));
        },
        onLog: (level, data) => console.log(`[widget:${callId}] ${level}`, data),
        onTeardownRequested: () => onFallbackRef.current("widget requested teardown"),
        onOpenLinkNotice: (message) => onOpenLinkNoticeRef.current(message),
        onWidgetMessage: (text) => onWidgetMessageRef.current(text),
        onCallToolOutcome: (ok) => {
          consecutiveFailuresRef.current = ok ? 0 : consecutiveFailuresRef.current + 1;
          if (consecutiveFailuresRef.current >= 3) onFallbackRef.current("widget's tool calls failed repeatedly");
        },
      });

      bridge.addEventListener("initialized", () => {
        if (cancelled) return;
        window.clearTimeout(initTimer);
        setPhase("mounted");
        onMountedRef.current();
      });

      const transport = new PostMessageTransport(contentWindow, contentWindow);
      // R-3 step 3: connect() attaches the transport's message listener.
      await bridge.connect(transport);
      if (cancelled) return;

      let bootstrap: api.BootstrapResponse;
      try {
        bootstrap = await api.bootstrapWidget(sessionId, callId);
      } catch (err) {
        onFallbackRef.current(err instanceof Error ? err.message : String(err));
        return;
      }
      if (cancelled) return;
      if (!bootstrap.html) {
        onFallbackRef.current("widget resource returned no HTML");
        return;
      }

      const csp = buildWidgetCsp(trust, bootstrap.csp);
      const html = injectWidgetPreamble(bootstrap.html, csp, currentTheme());

      iframeEl.setAttribute("sandbox", WIDGET_SANDBOX);
      iframeEl.setAttribute("allow", buildWidgetAllow(trust, bootstrap.permissions));
      iframeEl.setAttribute("referrerpolicy", "no-referrer");

      initTimer = window.setTimeout(() => {
        if (cancelled) return;
        onFallbackRef.current(`widget did not initialize within ${widgetInitTimeoutMs}ms`);
      }, widgetInitTimeoutMs);

      // R-3 step 4 (last): only now does srcdoc get set.
      iframeEl.srcdoc = html;
    }

    mount().catch((err) => {
      if (!cancelled) onFallbackRef.current(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      window.clearTimeout(initTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountable]);

  // Flush queued sendToolInput -> sendToolResult, strictly in order, once mounted.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (phase !== "mounted" || !bridge || !props.input || sentInputRef.current) return;
    sentInputRef.current = true;
    bridge.sendToolInput({ arguments: props.input }).catch(() => undefined);
  }, [phase, props.input]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (phase !== "mounted" || !bridge || !props.result || !sentInputRef.current || sentResultRef.current) return;
    sentResultRef.current = true;
    bridge.sendToolResult(props.result as never).catch(() => undefined);
  }, [phase, props.result]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!props.cancelled || phase !== "mounted" || !bridge || sentResultRef.current || sentCancelledRef.current) return;
    sentCancelledRef.current = true;
    bridge.sendToolCancelled({ reason: "Turn ended before this tool call completed." }).catch(() => undefined);
  }, [props.cancelled, phase]);

  useEffect(() => {
    return () => {
      api.teardownWidget(sessionId, callId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <iframe
      ref={iframeRef}
      title={`widget-${callId}`}
      style={{ width: "100%", height, border: "none", display: "block" }}
      // No `src`/`srcdoc` here initially — set imperatively in the effect
      // above, strictly after `bridge.connect()` (R-3).
    />
  );
}
