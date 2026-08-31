/**
 * Thin re-export seam (§3 of the design). The backend can safely import
 * `@modelcontextprotocol/ext-apps/app-bridge` from Node: the only `window.`
 * references in the bundled module are inside `PostMessageTransport` method
 * bodies, not at module scope, so importing it here never touches the DOM.
 * This file exists so that if a future SDK version moves DOM access to
 * module scope, only this file changes.
 */
export {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
} from "@modelcontextprotocol/ext-apps/app-bridge";
export type { McpUiResourceCsp, McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";
