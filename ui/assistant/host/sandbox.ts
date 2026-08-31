/**
 * CSP string builder + sandbox/allow attribute computation + HTML preamble
 * injection (design §8.3, D-10).
 */
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Trust } from "../api";

export const WIDGET_SANDBOX = "allow-scripts";

interface DeclaredCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

function directive(name: string, strictDefault: string, extra?: string[]): string {
  if (extra && extra.length > 0) return `${name} ${extra.join(" ")}`;
  return `${name} ${strictDefault}`;
}

/**
 * D-10: `_meta.ui.csp` is honoured only for `trust: "builtin"`. For
 * `trust: "user"` the declared policy is ignored outright and the strictest
 * default applies regardless of what the server asked for.
 */
export function buildWidgetCsp(trust: Trust, declared?: DeclaredCsp): string {
  const honour = trust === "builtin";
  const resourceList = honour && declared?.resourceDomains?.length ? declared.resourceDomains.join(" ") : undefined;
  const withResources = (base: string) => (resourceList ? `${base} ${resourceList}` : base);

  return [
    "default-src 'none'",
    withResources("script-src 'unsafe-inline'"),
    withResources("style-src 'unsafe-inline'"),
    withResources("img-src data: blob:"),
    withResources("font-src data:"),
    withResources("media-src data:"),
    directive("connect-src", "'none'", honour ? declared?.connectDomains : undefined),
    directive("frame-src", "'none'", honour ? declared?.frameDomains : undefined),
    directive("base-uri", "'none'", honour ? declared?.baseUriDomains : undefined),
    "form-action 'none'",
  ].join("; ");
}

export function buildWidgetAllow(trust: Trust, permissions?: Record<string, object>): string {
  if (trust !== "builtin") return "";
  return buildAllowAttribute(permissions);
}

/**
 * Injects the CSP `<meta>` tag and a small theme-bootstrap script as the
 * first child of `<head>` (or the document start if there is no `<head>`).
 * A single anchored string splice — no HTML parsing of untrusted content,
 * per design §8.3.
 */
export function injectWidgetPreamble(html: string, csp: string, theme: "light" | "dark"): string {
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  // T-11 / simplification #3: this stamps `data-theme` + `color-scheme` for
  // any widget following the conventional `data-theme` attribute (including
  // third-party ones we cannot modify). Our own bundled widgets additionally
  // pick up host-driven theme changes via `applyDocumentTheme` in
  // `ui/shared/useSalesApp.ts` once mounted (see that file's `onhostcontextchanged`).
  const themeScript = `<script>document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};</script>`;
  const preamble = metaTag + themeScript;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + preamble + html.slice(insertAt);
  }
  return preamble + html;
}
