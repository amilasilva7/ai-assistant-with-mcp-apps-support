import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export function currentTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Builds the host context sent at `ui/initialize` and kept live via `setHostContext` (design §7.1). */
export function initialHostContext(opts: { widthPx: number; theme: "light" | "dark" }): McpUiHostContext {
  return {
    theme: opts.theme,
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { width: opts.widthPx, maxHeight: 720 },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: "income-mcp-assistant/0.1.0",
    platform: "web",
    deviceCapabilities: {
      touch: window.matchMedia?.("(pointer:coarse)").matches ?? false,
      hover: window.matchMedia?.("(hover:hover)").matches ?? true,
    },
    // Explicit zeros (not omitted) so ui/shared/safeArea.ts's safeAreaStyle()
    // produces deterministic 0px paddings instead of undefined.
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}
