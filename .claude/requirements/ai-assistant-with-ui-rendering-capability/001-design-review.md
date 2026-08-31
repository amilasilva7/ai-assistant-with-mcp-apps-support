# Design Review: 001-design.md vs. 001-requirements.md

Reviewed `.claude/requirements/ai-assistant-with-ui-rendering-capability/001-design.md` against `.../001-requirements.md`, for the income-mcp project's "AI assistant with UI rendering capability" feature.

## Verification of the design's factual claims (all spot-checks passed)

The design's citations are unusually accurate. Confirmed against `node_modules\@modelcontextprotocol\ext-apps\dist\src\app-bridge.d.ts`:
- `constructor(_client: Client | null, ...)` at `:262`; the `null` + manual-handler mode is documented at `:249-260` and `:1306-1317`; `connect()` throws **only** "If a client was passed" (`:1285-1288`) — so D-1's claim that `null` is a first-class mode is correct.
- `getToolUiResourceUri` `:34`, `isToolVisibilityModelOnly` `:41`, `isToolVisibilityAppOnly` `:48`, `buildAllowAttribute` `:65` all exist.
- The `./app-bridge` subpath export exists (`node_modules/@modelcontextprotocol/ext-apps/package.json` lines 33-36), and every `window.`/`document.` reference in the bundled `app-bridge.js` is inside method bodies or a default parameter — module scope is clean, so the Node-side import in `assistant/uiMeta.ts` is safe as claimed.
- `PostMessageTransport(eventTarget: Window|undefined, eventSource: MessageEventSource)` (`message-transport.d.ts:62`), sends with `"*"` origin and validates `event.source` — compatible with an opaque-origin `srcdoc` frame.
- `McpUiHostCapabilities` (`spec.types.d.ts:361-399`) — every capability name in D-11 exists, including `message`/`updateModelContext` as `McpUiSupportedContentBlockModalities` (`:331-344`). `McpUiHostContext` (`:221-282`) — every field in §7.1 exists. `_meta.ui.csp` at `:467`.
- MCP SDK: `InMemoryTransport.createLinkedPair()` (`inMemory.d.ts:19`); client `start()` does not open the GET (`client/streamableHttp.js:257-262`); the GET is attempted only after the `202` for `notifications/initialized` (`:371-378`); `405` is swallowed (`:101-105`) and every other status becomes `StreamableHTTPError`. **D-2's central technical argument (Express 404 → spurious `onerror`) is factually correct.**
- Repo: `server/main.ts:19,22,25,32-35,41` all as described; `server/server.ts` reads `dist/ui/*.html` lazily inside the resource handler and passes only `{ mimeType }` (so the bundled widgets declare no CSP/permissions, as §8.3 claims); `vite.config.ts:5-8` throws without `INPUT`; `package.json` has no test script; `ui/shared/useSalesApp.ts` never applies a theme; `ui/shared/safeArea.ts` reads `hostContext.safeAreaInsets`; `ui/shared/theme.css:45` keys dark on `:root[data-theme="dark"]` — and its header comment explicitly anticipates "an explicit host `data-theme` stamp," which strengthens §7.1's approach.

The four resolved open questions (D-1 backend client, D-2 in-process + port 3002, D-3 Anthropic, D-4 widget-plus-text) are each justified with a defensible argument, and each is consistent with the rest of the document. No reason found to overturn any of them.

---

## Gaps

**G-a. FR-D3's acceptance criterion is not satisfiable by this design, and the design doesn't say so.** FR-D3 requires that when a hostile widget attempts top-navigation or an external script load, "the chat surfaces a rendering error rather than allowing it silently." In an `allow-scripts`-only `srcdoc` iframe the host has zero visibility into guest CSP violations: `securitypolicyviolation` fires inside the guest, and `report-to`/`report-uri` can't reach the host under `connect-src 'none'`. §8.3/§8.4 only surface notices for *declared* `csp`/`permissions` and for `openLink`/`downloadFile` requests — never for an actual runtime block. §12.3's expectation ("all three must fail") is verifiable only in devtools. Either state the deviation explicitly (recommended) or drop the AC in the requirements.

**G-b. `onreadresource`/`onlistresources` are declared but effectively unimplemented.** D-11 declares `serverResources` with "proxied read/list", and §5.3 registers all four handlers — but §5.1 and §8.2(4) restrict `/api/mcp/read-resource` to serve **only** `binding.resourceUri`. A widget that reads a data resource from its own server (a normal MCP Apps pattern) gets its own HTML back or an error. The endpoint is also doing two unrelated jobs: the *host's* widget-HTML bootstrap (returns `{html, csp, permissions, trust}`) and the *widget's* proxied `resources/read`. Split them, and scope proxied reads to the bound server rather than a single URI — or don't declare the capability.

**G-c. Untrusted `tools/list` metadata is unbounded.** FR-B4/§5.6 bound tool *results*; nothing bounds tool count, name length, description length, or schema size from a user-added server. D-9's own rationale calls tool descriptions "attacker-controlled text that reaches a model" — yet that text enters every request unbounded. A server exposing 2,000 tools or a 500 KB description inflates every turn's cost/context with no guard.

**G-d. NFR-Perf-1 has no threshold and no verification.** The prior requirements review (A-3) asked for numbers; the traceability table maps NFR-Perf-1/2 to §12.2 #9, which only covers the add-server timeout. There is no time-to-first-token scenario or target anywhere.

**G-e. Concurrency policy for `/api/chat` is undefined.** `Session.activeTurn` exists, but no route behavior is specified for a second `POST /api/chat` while a turn is live — and §5.3's `onmessage` handler explicitly starts a new turn from a widget, which can fire mid-stream. The prior requirements review (A-2) raised this; it isn't closed. Needs an explicit rule (409, or queue-and-serialize).

**G-f. FR-C5 "reconnect" is manual only.** `/api/servers/:id/reconnect` + a Retry button; no retry/backoff or health re-check. Defensible for a POC, but it should be stated as a decision (the prior requirements review's A-6 flagged the same gap in the requirements).

**G-g. Source-of-truth drift.** The design header calls `001-requirements.md` "(approved)", but that file's status is "Draft for review" and `001-requirements-review.md`'s verdict is **Send back** with a "Required before re-review" list that was never applied. The design absorbs those fixes instead, so the requirements doc now *contradicts* the design in several places (FR-D3's allowlist clause vs. D-10; OQ2/4/6/7 still open; §7's "no changes to the existing server" vs. §3.3). Acceptance testing against a stale requirements doc will produce false failures. Back-port the decisions or re-status the requirements doc.

## Risks

**R-1. One malformed tool schema from one user-added server takes down the whole assistant.** D-3's "no schema translation layer is needed" is true for well-formed servers, but Anthropic rejects non-conforming `input_schema` (e.g. non-object root) with a 400 on the *entire* request. Since the tool list is aggregated, a single bad tool makes **every** turn fail — a direct violation of NFR-Reliability-1 ("a failure in one connected MCP server must not prevent the assistant from answering prompts that don't need that server"). Add shape validation at registration (drop/flag non-conforming tools) plus quarantine-and-retry-once on a provider 400.

**R-2. Untrusted widget code executes before the D-9 approval gate.** §6.2 mounts the `ToolResultCard`/`WidgetFrame` and issues `read-resource` at `tool_call_start`; D-9 blocks *execution* later. For `trust: "user"` that means the untrusted server's HTML+JS is fetched and running in the browser before the user has approved anything. Gate the mount on approval for user-added servers (built-in can keep the early mount that NFR-Perf-1 wants).

**R-3. Iframe handshake ordering race.** `iframe.contentWindow` is null before DOM attachment, and the transport's `window` message listener is attached in `bridge.connect()`. If `srcdoc` is set before `connect()` resolves, `ui/initialize` is dropped → 5s `WIDGET_INIT_TIMEOUT` → silent text fallback that looks like flake. Neither §5.3 nor §6.2 states the required order (attach iframe → capture `contentWindow` → `await bridge.connect(transport)` → set `srcdoc`). Make it a normative rule; note that the WindowProxy identity survives the `srcdoc` navigation, so the `event.source` check still passes.

**R-4. `node --env-file=.env` throws ENOENT when `.env` is absent** (Node only tolerates a missing file with `--env-file-if-exists`). A user who exports `ANTHROPIC_API_KEY` in their shell gets a Node crash instead of FR-B2's "clear configuration error" — the acceptance criterion fails on the very path it describes. Use `--env-file-if-exists`, or load the file inside `config.ts`.

**R-5. `dev:assistant` is dead on arrival against the §8.1 Origin guard.** The Vite dev server proxying `/api → 3002` sends `Origin: http://localhost:5173`; the guard 403s anything that isn't `http://{127.0.0.1,localhost}:<port>` (`changeOrigin` rewrites Host, not Origin). Either allowlist the dev origin behind a flag or drop the dev script.

**R-6. Dangling/incomplete SPA CSP.** §8.1 defers the SPA's own `Content-Security-Policy` to "the caveat in §11.2" — §11.2 is the widget-fallback detection rule and contains no such caveat. Separately, the SPA policy must permit `srcdoc` child frames; a `frame-src 'none'`-style policy would break the entire host. Specify the SPA CSP concretely.

**R-7. Approval timeout vs. turn timeout.** 60s per approval, potentially several (concurrency 4, sequential user attention) against a 120s `ASSISTANT_TURN_TIMEOUT_MS`. A careful user times out their own turn. Either pause the turn timer while awaiting approval or document the interaction.

**R-8. `uncaughtException` handler that does not exit** keeps a possibly-corrupted process serving. Justified in §11.3 by NFR-Reliability-1, but it's a real tradeoff that deserves to be listed in §13 rather than asserted.

**R-9. Small scope creep in `server/main.ts`.** Once D-2 makes the built-in server in-process, the `405` handlers are no longer needed for FR-C1 — they exist only to make manual test #8 clean. It's ~8 lines and genuinely low-risk, but it is a change to a file the requirements §7 puts out of scope. Fine to keep if called out as optional/separable; rollback is trivial either way.

Migration/rollback risk overall is low: the change is additive, `dist/` is already gitignored, and reverting means not running `npm run assistant`. The one coupling worth noting is that adding `assistant/**` to `tsconfig.json` puts new code inside the repo's *only* automated gate (`npm run typecheck`) — including `assistant/dev/hostileServer.ts`.

## Simplifications

1. **Fold `/api/events` into the chat stream or replace it with polling `/api/servers`.** Three concurrent streaming channels (chat NDJSON, events NDJSON, per-widget postMessage) is a lot of machinery for single-user server-status chips; it's P1 anyway.
2. **Replace per-tool, mid-loop approval (D-9) with a per-server trust prompt at add time** (or a global auto-approve toggle defaulting off). That keeps the agentic loop synchronous — no `pendingApprovals` map, no 60s timers inside a stream, no deny→`tool_result` plumbing — for most of the same mitigation. D-9 is the most intricate piece of P0 and the least required by the requirements.
3. **Theme (T-11):** the requirements' §7 exclusion names `server/` and `ui/apps/*` — not `ui/shared/*` — and the design already edits `server/main.ts`. A two-line call to the SDK's `applyDocumentTheme` (`styles.d.ts:62`) inside `ui/shared/useSalesApp.ts` is the sanctioned path for our own widgets; keep the HTML injection only as an optional extra for third-party widgets. The scope reasoning as written is internally inconsistent.
4. **Split the widget-bootstrap endpoint from the proxied `resources/read`** (see G-b) — this removes a contradiction rather than adding code.
5. **Script naming:** `"assistant"` is a noun; FR-E2 requires `<verb>[:<detail>]`. `serve:assistant` matches `serve` / `serve:stdio`.
6. Minor: §12.3 calls the hostile fixture a "stdio/HTTP" server; it must be HTTP-only since the add-server path is HTTP-only per D-12.

## Test strategy adequacy

Honest and well-matched to a repo with no runner: §12.1's reliance on `npm run typecheck` is genuinely load-bearing given how strict the MCP Apps types are, and the 17 named scenarios with concrete prompts close prior review items A-5 and C-3. Weaknesses: no NFR-Perf-1 measurement (G-d); scenario 14 cannot actually observe CSP blocks from the chat (G-a); nothing exercises R-1 (malformed tool schema) or G-e (concurrent turns) — both are cheap additions to the hostile fixture and the manual plan. The four optional `node --test` units are the right four.

---

## Verdict: **Approve with changes** (not a Send back)

The architecture is sound, the four resolved decisions are well-argued and mutually consistent, and every SDK/repo claim sampled checked out. Nothing here requires re-architecting or new analysis — the findings are localized fixes. Conditions before implementation starts:

- **Must fix:** R-1 (tool-schema validation/quarantine — it's an NFR-Reliability-1 violation), R-2 (mount after approval for untrusted servers), G-b (read-resource contradiction), R-3 (handshake ordering rule), R-4 (`--env-file-if-exists`), R-6 (real SPA CSP + fix the dangling §11.2 reference).
- **Must state:** G-a (FR-D3 AC deviation), G-e (concurrent-turn policy), G-c (caps on untrusted tool metadata), G-f (manual reconnect only), G-g (reconcile the requirements doc's status and its now-superseded clauses).
- **Should consider:** simplifications 1-3 and 5; R-5, R-7, R-8, R-9.

### Files consulted
`001-design.md`, `001-requirements.md`, `001-requirements-review.md`, `server/main.ts`, `server/server.ts`, `ui/shared/useSalesApp.ts`, `ui/shared/theme.css`, `vite.config.ts`, `package.json`, `tsconfig.json`.
</content>
