/**
 * Per-widget-instance `AppBridge` wiring (design §5.3). One `AppBridge` per
 * widget instance, constructed with `null` (D-1): every handler it would
 * otherwise auto-forward is registered manually here and proxied over the
 * assistant's own HTTP API.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps";

export const HOST_INFO = { name: "income-mcp-assistant", version: "0.1.0" };

/**
 * Same declaration regardless of trust level — trust changes the CSP/sandbox
 * (host/sandbox.ts) and mount-gating (R-2), not which bridge capabilities
 * are declared. `downloadFile` and `sampling` are intentionally not
 * registered/declared (D-11): an untrusted iframe must not be able to spend
 * LLM credits or make the host fetch arbitrary URLs on its behalf.
 */
export function hostCapabilities(): McpUiHostCapabilities {
  return {
    serverTools: { listChanged: true },
    serverResources: { listChanged: false },
    logging: {},
    openLinks: {},
    updateModelContext: { text: {}, structuredContent: {} },
    message: { text: {} },
  };
}

export interface BridgeContext {
  sessionId: string;
  widgetInstanceId: string;
  onSizeChange: (height: number | undefined, width: number | undefined) => void;
  onLog: (level: string, data: unknown) => void;
  onTeardownRequested: () => void;
  onOpenLinkNotice: (message: string) => void;
  onWidgetMessage: (text: string) => void;
  onCallToolOutcome: (ok: boolean) => void;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json() as Promise<T>;
}

/** Registers the full handler surface named in design §5.3. */
export function registerHandlers(bridge: AppBridge, ctx: BridgeContext): void {
  bridge.oncalltool = async (params) => {
    try {
      const result = await postJson<{ isError?: boolean; content: unknown[] }>("/api/mcp/call", {
        sessionId: ctx.sessionId,
        widgetInstanceId: ctx.widgetInstanceId,
        name: params.name,
        arguments: params.arguments,
      });
      ctx.onCallToolOutcome(!result.isError);
      return result as never;
    } catch (err) {
      ctx.onCallToolOutcome(false);
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] } as never;
    }
  };

  bridge.onreadresource = async (params) => postJson("/api/mcp/read-resource", { sessionId: ctx.sessionId, widgetInstanceId: ctx.widgetInstanceId, uri: params.uri });

  bridge.onlistresources = async (params) => postJson("/api/mcp/list", { sessionId: ctx.sessionId, widgetInstanceId: ctx.widgetInstanceId, what: "resources", cursor: params?.cursor });
  bridge.onlistresourcetemplates = async (params) =>
    postJson("/api/mcp/list", { sessionId: ctx.sessionId, widgetInstanceId: ctx.widgetInstanceId, what: "resourceTemplates", cursor: params?.cursor });
  bridge.onlistprompts = async (params) => postJson("/api/mcp/list", { sessionId: ctx.sessionId, widgetInstanceId: ctx.widgetInstanceId, what: "prompts", cursor: params?.cursor });

  bridge.addEventListener("loggingmessage", (params) => ctx.onLog(params.level, params.data));

  bridge.addEventListener("requestteardown", () => {
    bridge
      .teardownResource({})
      .catch(() => undefined)
      .finally(() => ctx.onTeardownRequested());
  });

  bridge.addEventListener("sizechange", (params) => ctx.onSizeChange(params.height, params.width));

  // Replaces the SDK's default (echo current mode): "inline" always granted,
  // "fullscreen" granted (host renders the chrome — see ToolResultCard),
  // "pip" denied (not implemented in v1, design §7.3).
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (mode === "inline" || mode === "fullscreen") return { mode };
    return { mode: "inline" };
  };

  bridge.onopenlink = async ({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.onOpenLinkNotice(`Blocked an invalid link.`);
      return { isError: true };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      ctx.onOpenLinkNotice(`Blocked a "${parsed.protocol}" link (only http/https are allowed).`);
      return { isError: true };
    }
    const confirmed = window.confirm(`Open this link in a new tab?\n\n${url}`);
    if (!confirmed) return { isError: true };
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) ctx.onOpenLinkNotice(`The browser blocked the popup for ${url}.`);
    return {};
  };

  // D-11: capability not declared; handler still registered defensively.
  bridge.ondownloadfile = async () => ({ isError: true });

  bridge.onupdatemodelcontext = async (params) => {
    await postJson("/api/model-context", {
      sessionId: ctx.sessionId,
      widgetInstanceId: ctx.widgetInstanceId,
      content: params.content,
      structuredContent: params.structuredContent,
    });
    return {};
  };

  bridge.onmessage = async (params) => {
    const text = (params.content ?? [])
      .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim() !== "") ctx.onWidgetMessage(text);
    // Never return conversation content — the SDK docs call this out
    // explicitly as an information-leak guard.
    return {};
  };
}
