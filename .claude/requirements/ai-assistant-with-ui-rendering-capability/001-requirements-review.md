# Review: 001-requirements.md vs. 001-request.md

Reviewed: `.claude/requirements/ai-assistant-with-ui-rendering-capability/001-requirements.md` (494 lines) against `.../001-request.md` (1 line), grounded against `ARCHITECTURE.md`, `README.md`, `package.json`, `server/main.ts`, `server/server.ts`, `ui/shared/useSalesApp.ts`, `ui/shared/safeArea.ts`, and `node_modules/@modelcontextprotocol/ext-apps/`.

**Overall:** structurally strong and factually accurate where it cites the repo (Background table claims in §1 verified line-by-line — `registerAppTool`/`registerAppResource`, `PORT` default 3001, the ARCHITECTURE §2 "the server never knows or cares which path is taken" quote, the README basic-host pointer, the "trusts every caller completely" line — all correct). The problems are omissions in the *primary* ask, not sloppiness in what is there.

---

## Gaps

**G-1. The central phrase of the request was silently resolved, not flagged.**
The request says "should render UIs **with** textural results." Two readings: (a) render the widget *and* the text summary together, or (b) render the widget, *falling back to* text. The doc commits entirely to (b) — G4, FR-D4, §0 ("or as plain text/markdown when no widget is available"). Reading (a) is at least as natural given the wording, and it changes the UI design (every tool turn shows both a widget and a collapsible markdown summary). This never appears in §8's nine open questions. This is the single most load-bearing ambiguity in a one-line request and it was resolved by assumption.

**G-2. The MCP Apps host protocol surface is ~60% missing from Section D — the exact thing the request calls "MCP app support."**
`@modelcontextprotocol/ext-apps@1.7.5` is already a dependency of this repo and already ships the host-side SDK at the `./app-bridge` export (`node_modules/@modelcontextprotocol/ext-apps/package.json` lines 33-36). The doc never mentions it; §1's Background table lists only the external `basic-host` as the "reference host implementation," which understates what already exists in-tree and leaves the biggest feasibility question unexamined. Reading `app-bridge.d.ts` shows concrete host obligations that FR-D1–D5 do not cover:

- **Host capability declaration.** `new AppBridge(client, hostInfo, { openLinks: {}, serverTools: {}, logging: {} })` — the host must declare which capabilities it supports. No requirement decides `openLinks` / `logging` / sampling.
- **Host context propagation.** `McpUiHostContext`, `McpUiHostContextChangedNotification`. This repo's own widgets consume it: `ui/shared/useSalesApp.ts` lines 13, 26-27, 32 (`onhostcontextchanged`, `getHostContext()`) and `ui/shared/safeArea.ts` reads `hostContext.safeAreaInsets`. If the assistant doesn't supply host context, the bundled widgets degrade — yet FR-D1 lists only `ui/initialize`, tool-result push, and `ui/callServerTool`.
- **Size negotiation.** `McpUiSizeChangedNotification` (`ui/notifications/size-changed`, width/height). A widget in a chat transcript has no natural height. No requirement covers iframe sizing.
- **Display mode.** `McpUiRequestDisplayModeRequest` — inline vs. fullscreen/expanded. Directly relevant to "nice UI" and unaddressed.
- **`McpUiOpenLinkRequest` and `McpUiDownloadFileRequest`.** FR-D3 says "no top-level navigation," but the protocol has explicit *requests* for opening links and downloading files. For untrusted user-added servers this needs an allow/deny/prompt policy. Missing entirely.
- **`McpUiUpdateModelContextRequest`.** The protocol's mechanism for a widget to push state into the LLM's context. This is the answer to "does clicking a filter change what the LLM knows?" — a question FR-A4 ("a reference to any rendered widget/tool result") leaves undefined.
- **`McpUiResourcePermissions` / `buildAllowAttribute()`** (iframe `allow` for microphone, clipboard-write, etc.). FR-D3 covers `sandbox` and CSP but says nothing about Permissions Policy requests from an untrusted server.
- **Tool visibility.** `isToolVisibilityModelOnly()` / `isToolVisibilityAppOnly()`. FR-B1 requires sending "the aggregated tool list from all connected/enabled MCP servers" to the LLM. That is wrong as written: app-only tools must be excluded from the LLM's tool list, and FR-C3's server panel should reflect visibility too. This is a correctness defect, not a nuance.
- **`McpUiToolCancelledNotification` / `McpUiToolInputPartialNotification`.** Cancellation and streaming tool input to widgets — related to G-6 below.

**G-3. Tool-name collisions across servers.** "Users should be able to add any mcp server" means two servers can both expose `search` or even `get_daily_sales_trend`. FR-B1 aggregates tool lists; nothing requires namespacing (`<server>__<tool>`) or defines routing when names collide. This is a hard blocker for the request's second sentence and appears nowhere in the doc.

**G-4. No bound on the agentic loop.** FR-B1 defines "execute tool → feed result back → LLM responds" with no cap on iterations, wall-clock time, or token spend. FR-B4 bounds result *size* only. ARCHITECTURE.md line 226 explicitly warns "an LLM agent can retry a tool in a loop." A POC with an API key and untrusted servers needs a max-iterations requirement.

**G-5. No requirement binds the assistant to loopback.** §7 removes auth from the assistant page; FR-B2 puts an LLM API key server-side; FR-C2 lets any caller make the backend issue outbound HTTP to an arbitrary URL. Combined, anyone reachable on that port can spend the owner's LLM credits and use the process as an SSRF pivot. NFR-Security-1 waves this off as "the user's own choice to make," which is only true under a single-local-user assumption that is stated in §7 but never converted into an enforceable requirement. Add: "binds to 127.0.0.1 by default; binding to 0.0.0.0 requires an explicit opt-in env var."

**G-6. Missing chat edge cases:** stop/cancel generation; aborting an in-flight tool call; submitting a second prompt while a turn is in flight (FR-A1 says input is re-enabled "until a response starts" — see A-2); empty/first-run state of the page; non-text tool content (MCP tools may return `image`/`resource` content blocks — FR-D4 assumes text or widget only, with no out-of-scope line covering the rest).

**G-7. MCP client capabilities toward added servers are undeclared.** Sampling (`sampling/createMessage`), elicitation, and roots are all things a user-added server may request of a host that has an LLM. `app-bridge.d.ts` line 3 imports `CreateMessageRequest`/`CreateMessageResultWithTools`, so it's live in this SDK version. The doc must either support or explicitly decline these; today it's silent, which is neither.

**G-8. Widget builds are a hidden prerequisite.** `server/server.ts` lines 16-23 read widget HTML from `dist/ui/*.html`. FR-C1 claims the default server makes the assistant "immediately useful without any manual setup," and FR-D1's AC asserts the trend chart renders. Both are false unless `npm run build` has run. Needs a startup precondition/validation requirement.

**G-9. "Nice UI" — the request's only adjective — has no requirement.** NFR-Accessibility-1 mentions reusing `ui/shared/theme.css` tokens parenthetically. Nothing covers layout, responsive behavior, or light/dark (ARCHITECTURE.md line 111 notes theme.css is light-dark aware, and widgets expect the host to tell them the theme via host context — see G-2). Either add a minimal visual-consistency NFR or state that visual polish is deferred.

**G-10. No prioritization or phasing.** 22 FRs + 10 NFRs derived from one sentence, all reading as mandatory, for a repo the doc itself calls a POC. There is no must/should/could split and no v1 slice. FR-A2 (streaming), FR-B3 (parallel tool calls), FR-C4 (disable toggle), FR-D5 (multi-widget) are all reasonable but none are in the request.

---

## Contradictions

**C-1. FR-D3 vs. Open Question 7.** FR-D3 states as a requirement that "a default-deny CSP is applied *unless the resource declares an explicit, narrower allowlist*." OQ7 then asks whether we trust a server-declared CSP at all "or hard-code a maximally restrictive sandbox with no allowlist mechanism at all for v1." FR-D3 has already decided the question OQ7 says is open. Separately, the wording is technically wrong: an allowlist layered on default-deny is *broader*, not "narrower."

**C-2. §7 decides what §8 reopens.** §7 states as settled out-of-scope: stdio-transport servers, and no cross-session persistence of servers/history. §8 OQ2 and OQ4 then present both as undecided. A reader cannot tell whether these are decisions or proposals. Pick one framing (suggest: §7 entries marked "proposed — pending OQn").

**C-3. §9 traceability vs. §7 exclusions.** §9 lists the acceptance signal for FR-B1–B4 as "Given a known prompt, the correct tool(s) fire with correct args," while §7 explicitly excludes "CI eval harnesses for tool routing." So the stated acceptance signal has no supporting mechanism, and LLM non-determinism makes ad-hoc checking unreliable. Either scope a fixed prompt fixture set with a stated pass bar, or reframe FR-B1's AC around loop mechanics rather than routing accuracy.

**C-4. §5's own rule is violated.** §5's preamble: "Each requirement has an id, a short statement, and Given/When/Then acceptance criteria." FR-E1 and FR-E2 have no acceptance criteria at all, and FR-E2 is largely a note about what does *not* apply ("a `--stdio`-style CLI flag pattern is *not* applicable here").

**C-5. §3 non-goal vs. security FRs.** "Not production hardening" sits alongside FR-D3, FR-B4, NFR-Security-1/2/3. These aren't literally contradictory — untrusted third-party servers make some hardening baseline, not gold-plating — but the doc should say which security items are must-have-for-v1 and which are best-effort, or FR-D3's AC (demonstrating a sandbox blocks a hostile widget) implies building an attack widget that nothing else in the doc scopes.

**C-6. §7 "no changes to the existing server" vs. FR-C1/FR-E2/OQ6.** §7 says `server/` remains as-is "except to the extent they need to be *reachable* as the default registered server," but OQ6 contemplates running the assistant inside `server/main.ts`, and FR-E2 contemplates new env vars and npm scripts. The escape clause papers over a real fork; see R-2.

---

## Ambiguities

**A-1.** FR-D4's fallback trigger list ("no `_meta.ui.resourceUri`, or the resource fails to load/initialize, or the widget itself errors after mounting") is good, but "the widget itself errors after mounting" is unobservable from the host unless a specific signal is named (handshake timeout duration? `ui/notifications/initialized` not received within N ms? a logging notification at level `error`?). Give a concrete detection rule and timeout, otherwise the AC "does not leave a blank or perpetually-loading widget slot" can't be tested.

**A-2.** FR-A1: "the input is cleared/disabled until a response starts." Cleared *or* disabled — which? And re-enabling when the response *starts* (rather than completes) implies concurrent turns are allowed, which nothing else in the doc handles.

**A-3.** NFR-Perf-1 and NFR-Perf-2 both say "within a few seconds"; §9 says these will be "measured under normal conditions" — against no threshold. Not testable. Give numbers (e.g. TTFT p50 ≤ 2s / p95 ≤ 5s locally; `tools/list` ≤ 5s with a 10s hard timeout).

**A-4.** FR-B4 requires results be bounded "per a documented limit" — the limit is undocumented and deferred to OQ8. As written the requirement cannot be implemented or verified. Same for whether the user is told truncation occurred.

**A-5.** FR-B3's AC: "a prompt that *reasonably* maps to two tools." Unfalsifiable; depends on the model. Name the exact prompt and the expected tool pair, and accept that it's a smoke test.

**A-6.** FR-C5 is titled "Reconnect / resilience" but neither the statement nor the AC requires any reconnection — only status updates and blast-radius isolation. Either drop "Reconnect" from the title or add a retry/backoff requirement.

**A-7.** FR-C2 doesn't define behavior for: duplicate URLs, duplicate display names, URL scheme validation, or a server that connects but exposes zero tools. FR-C3 mentions statuses "connected / error / disabled" while FR-C2's failure path says the server "is not added to the active tool set" — so is a failed server persisted in the list with `error` status, or discarded? The two requirements imply different answers.

**A-8.** FR-C3 lists only *tools* per server. MCP servers also expose resources and prompts, and the request says "talks to LLM, mcp server, MCP app." Tools-only is a fine v1 scope but must be an explicit out-of-scope line rather than an omission.

**A-9.** FR-E1 says UI-based registration is "required" while file/env seeding is "an open question" — but there's no AC and no statement of where the in-memory list lives relative to OQ4/OQ6. If the assistant is a separate process from `/mcp`, "pre-registered by default" (FR-C1) means hardcoding `http://localhost:3001/mcp`, which fails if `PORT` was overridden. Nothing covers that.

---

## Risks

**R-1. CORS makes "add any MCP server" fail if the MCP client lives in the browser.** `AppBridge` is browser-side (it wraps `iframe.contentWindow` via `PostMessageTransport`) and auto-forwards to an MCP `Client` passed into its constructor. The obvious implementation therefore puts the MCP client in the browser — but arbitrary third-party MCP servers will not send CORS headers for a random localhost origin. (This repo's own server only works with browsers because `server/main.ts` line 22 calls `app.use(cors())`.) The alternative — MCP clients in the Node backend, `AppBridge` constructed with `null` and manual `oncalltool` proxying — is a materially different architecture and is also what NFR-Security-2 ("credentials... never sent to the browser") demands if a server ever needs auth. The doc has no requirement or open question on where the MCP client lives, and FR-C2's AC ("Given a valid, reachable MCP Streamable HTTP endpoint... the server appears in the connected-servers list") will fail in practice for most real servers under the browser-side option. Add a requirement that connections to user-added servers are made server-side and proxied.

**R-2. Connecting to the default server may not work over its own HTTP endpoint as-is.** `server/main.ts` registers only `app.post("/mcp")` (line 25) with `sessionIdGenerator: undefined` and `enableJsonResponse: true` (lines 28-30) — no `GET` (SSE stream) or `DELETE` handler. A `StreamableHTTPClientTransport` that opens the GET stream will hit Express's default 404. This is exactly the integration the FR-C1 acceptance criterion depends on, and it's untested and unmentioned. Worth an explicit note that FR-C1 may require either an in-memory transport (assistant and server in one process) or adding GET/DELETE handlers — which then collides with C-6/§7's "no changes to the existing server."

**R-3. No test infrastructure exists.** `package.json` has `clean`, `build*`, `typecheck`, `serve`, `serve:stdio` — no test script, runner, or dev dependency for one. Every acceptance criterion in this doc is therefore manual. §9 admits "Manual/UI test" for the A-series but implies measurement and review elsewhere. The doc should state plainly that verification is manual for v1 (or scope a harness), otherwise "testable acceptance criteria" is aspirational across the board.

**R-4. Blocking open questions are not marked as blocking.** OQ1 (LLM provider), OQ6 (deployment topology), and the unlisted "where does the MCP client run" all gate FR-B1/B2/E2 and FR-C2/D1 respectively. Nine unranked open questions at "Draft for review" makes it unclear whether design can start. Mark the blockers.

**R-5. Effort/scope mismatch.** The doc's own §0 says "This is a substantial addition, not an incremental one," then specifies streaming, multi-server management, sandboxed third-party widget hosting, parallel tool calls, accessibility, and observability — all as v1. For a demo repo whose README says "this is a demo, not a product," this reads as a multi-week build with no phase-1 cut line.

---

## Verdict: **Send back**

The structure, repo grounding, and out-of-scope discipline are good, and most of §5 is reusable. But three findings are substantive gaps in the primary ask rather than polish, and fixing them requires new analysis rather than an editing pass:

1. **G-2** — Section D omits most of the MCP Apps host contract that already ships in this repo's own `@modelcontextprotocol/ext-apps` dependency (`./app-bridge`): host capabilities, host context, size negotiation, display mode, openLink/downloadFile policy, `updateModelContext`, resource permissions, and tool visibility filtering. "MCP app support" is the request's stated end goal; the doc under-specifies it while over-specifying chat affordances that weren't asked for.
2. **G-3** — tool-name collision/namespacing across servers is unaddressed and is a functional blocker for "users should be able to add any mcp server."
3. **G-1** — "render UIs with textural results" was resolved as fallback-only without flagging the alternative reading. Confirm with the requester before design.

### Required before re-review
- Add OQ: widget-plus-text vs. widget-or-text (G-1). Do not proceed on the fallback-only assumption.
- Rewrite §5-D against `@modelcontextprotocol/ext-apps/app-bridge`: add FRs for host capability declaration, host context propagation (theme/safe-area — cite `ui/shared/useSalesApp.ts`, `ui/shared/safeArea.ts`), iframe size negotiation, display-mode requests, openLink/downloadFile policy for untrusted servers, `ui/permissions` → `allow` attribute, and whether widget-initiated `updateModelContext` reaches the LLM.
- Add FR: tool namespacing/collision resolution across servers, and fix FR-B1 to filter by tool visibility (`isToolVisibilityAppOnly`) rather than sending the raw aggregated list.
- Add FR: max tool-call iterations / turn timeout (G-4). Add FR: loopback binding by default (G-5).
- Add an FR or OQ for where the MCP client runs (browser vs. backend) and state the CORS/credential consequence (R-1). Note the GET/DELETE gap in `server/main.ts` as a dependency of FR-C1 (R-2).
- Resolve C-1 (delete the allowlist clause from FR-D3 or close OQ7) and C-2 (mark §7 entries as "proposed, pending OQn").
- Give FR-E1/FR-E2 acceptance criteria or demote them out of §5 (C-4).
- Quantify NFR-Perf-1/2 and FR-B4's limit; replace "reasonably"/"a few seconds"/"a documented limit" with numbers.
- Add priority tags (must/should/could) and a v1 cut line; state that v1 verification is manual (R-3) and mark OQ1/OQ6 as blocking.

### Explicitly fine, no change needed
§1 Background (verified accurate), §3 non-goals, §7's auth/persistence/multi-tenant/governance exclusions (correctly inherited from ARCHITECTURE.md §5), FR-A3, FR-A5, FR-C3, FR-D5, NFR-Reliability-1, NFR-Observability-1.
</content>
