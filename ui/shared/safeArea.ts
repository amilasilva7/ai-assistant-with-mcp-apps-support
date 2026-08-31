import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CSSProperties } from "react";

export function safeAreaStyle(hostContext?: McpUiHostContext): CSSProperties {
  return {
    paddingTop: hostContext?.safeAreaInsets?.top,
    paddingRight: hostContext?.safeAreaInsets?.right,
    paddingBottom: hostContext?.safeAreaInsets?.bottom,
    paddingLeft: hostContext?.safeAreaInsets?.left,
  };
}
