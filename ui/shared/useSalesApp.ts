import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useEffect, useState } from "react";

/**
 * Shared plumbing for every widget: connects to the host, tracks the latest
 * tool result (structured data for the chart), and exposes `refetch` so
 * on-canvas filters can request fresh data without leaving the chat.
 */
export function useSalesApp<T>(toolName: string) {
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [pending, setPending] = useState(false);

  const { app, error } = useApp({
    appInfo: { name: toolName, version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp: App) => {
      createdApp.ontoolresult = async (r) => {
        setResult(r);
        setPending(false);
      };
      createdApp.onerror = (e) => console.error(e);
      createdApp.onhostcontextchanged = (params) => {
        setHostContext((prev) => ({ ...prev, ...params }));
      };
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  const refetch = useCallback(
    async (args: Record<string, unknown>) => {
      if (!app) return;
      setPending(true);
      try {
        const r = await app.callServerTool({ name: toolName, arguments: args });
        setResult(r);
      } finally {
        setPending(false);
      }
    },
    [app, toolName],
  );

  const data = (result?.structuredContent ?? null) as T | null;

  return { app, error, data, pending, hostContext, refetch };
}
