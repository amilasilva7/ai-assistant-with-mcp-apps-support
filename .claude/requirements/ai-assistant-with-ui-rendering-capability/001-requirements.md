# Requirements: AI Assistant with UI Rendering Capability

- **Source request:** [`001-request.md`](./001-request.md)
- **Status:** Draft for review
- **Author:** requirements-writer agent

## 0. Summary

Today, `income-mcp` is only the **MCP server** side of the picture (see
[ARCHITECTURE.md](../../../ARCHITECTURE.md)): it exposes tools + `ui://`
widget resources, and relies on an external **MCP host** (Claude Desktop,
Claude web, ChatGPT, Copilot, or the `ext-apps` `basic-host` dev harness) to
run the LLM, call tools, and render the returned widget or markdown.

This request asks for the project to *also* ship the host side: a
self-contained web page — "the AI assistant endpoint" — where a user types a
prompt, the assistant relays it to an LLM, the LLM decides which MCP tool(s)
to call (on this server and/or on other MCP servers the user has registered),
and the page renders the result either as the tool's interactive MCP Apps
widget (in a sandboxed iframe, per SEP-1865) or as plain text/markdown when no
widget is available or a host can't render it. Users can register additional
MCP servers of their own choosing, turning this page into a general-purpose,
extensible "AI assistant with MCP app support," not just a demo of the 4
sales-insights tools.

This is a substantial addition, not an incremental one: it adds an **MCP
client** and a **chat UI** to a codebase that has so far only ever played the
**MCP server** role. Sections 2–5 spell out exactly what "detailed" means here
before any of it is built.

## 1. Background — what already exists

| Concern | Existing pattern (reuse/extend) |
|---|---|
| Process entry point | `server/main.ts` — picks stdio vs. Streamable HTTP (`/mcp`), Express app, `PORT` env var (default `3001`) |
| Tool + widget registration | `server/server.ts` — `registerAppTool` / `registerAppResource` pairs, `_meta.ui.resourceUri` |
| Textual fallback | `server/format.ts` — every tool call returns both `content` (markdown) and `structuredContent` (JSON); "the key design point" per ARCHITECTURE.md §2 is that the *server* never picks which the caller sees — that responsibility today belongs entirely to the external host. This feature moves that responsibility, for the first time, into code we own. |
| Widget bundling | `ui/apps/<tool>/main.tsx`, one Vite `vite-plugin-singlefile` HTML bundle per widget, `useSalesApp` wrapping `@modelcontextprotocol/ext-apps/react`'s `useApp()` |
| Shared UI kit | `ui/shared/theme.css`, `BarChart`/`LineChart`, `Filters`, `safeArea.ts` |
| Reference host implementation | README.md points at `modelcontextprotocol/ext-apps` → `examples/basic-host` as "the fastest iteration loop" for exercising widgets today — this is the closest existing analogue to what's being requested, but it lives outside this repo and has no LLM/chat/prompt layer, no multi-server registration UI, and is a bare dev harness, not a product. |
| Auth / trust model | None. ARCHITECTURE.md §5 explicitly defers AuthN/AuthZ, and states the server "trusts every caller completely." This POC posture is assumed to continue unless a requirement below says otherwise. |

No existing code in this repo talks to an LLM, acts as an MCP *client*, or
renders a chat UI. All of that is new surface area.

## 2. Goals

- G1. A single web endpoint ("the assistant") where a user has a conversation
  (prompt in, response out) with an AI assistant.
- G2. The assistant can call tools on one or more MCP servers on the user's
  behalf, chosen by the LLM based on the prompt (standard LLM tool-calling
  loop).
- G3. When a called tool returns an MCP Apps widget (`_meta.ui.resourceUri`),
  the assistant renders that widget inline, interactively (filters etc. keep
  working via `callServerTool`, same as in Claude Desktop today).
- G4. When no widget is available, unsupported, or the widget errors, the
  assistant falls back to rendering the tool's textual/markdown `content` —
  the user is never blocked from seeing an answer.
- G5. A user can add a new MCP server (this project's own server is
  registered by default) and the assistant's next prompt can immediately use
  tools from that newly added server.
- G6. A user can see, at a glance, which servers are connected and which
  tools are available across all of them.

## 3. Non-goals (see also §7 Out of scope)

- This is not a rebuild of Claude Desktop/ChatGPT; it targets the same
  POC/demo fidelity as the rest of this repo, not production hardening.
- Not a replacement for the existing `sales-insights` MCP *server* role —
  that server continues to exist unchanged and is simply one of the (default)
  servers the new assistant client can connect to.

## 4. User stories

Persona: **an internal user** exploring/demoing MCP Apps (same audience as
the rest of this POC — no distinct roles/permissions are assumed).

1. **As a user**, I want to open one web page and type a natural-language
   question, so that I don't need a separate MCP-capable chat app (Claude
   Desktop/web, ChatGPT, Copilot) to try this out.
2. **As a user**, I want the assistant's answer to stream in as it's
   generated, so the experience feels responsive rather than a long blank
   wait.
3. **As a user**, I want a chart/table widget to render inline in the
   conversation when the tool the assistant called has one, so I get the
   same rich result Claude Desktop shows today.
4. **As a user**, I want to interact with a rendered widget (click a "7D /
   30D / 90D" filter, toggle a metric) and see it update in place without
   retyping my prompt, so the in-widget interactions work the same as they
   do in an external MCP host.
5. **As a user**, when a tool has no widget, or the widget fails to load, I
   want to see the plain-text/markdown summary instead, so I always get an
   answer.
6. **As a user**, I want to add a new MCP server by giving its connection
   details (at minimum a Streamable HTTP URL), so I can extend what the
   assistant can do without anyone editing server code.
7. **As a user**, I want to see a list of connected MCP servers and, per
   server, the tools it exposes (name + description), so I understand what
   I can ask the assistant to do.
8. **As a user**, I want to remove or temporarily disable an MCP server I
   added, so a broken or no-longer-needed connector stops being offered to
   the LLM.
9. **As a user**, I want to see clearly when a tool call is in progress and
   when it fails (server unreachable, tool error, LLM error), so I'm not
   staring at a silent UI.
10. **As a user**, I want my conversation to keep its history for the
    duration of my session (multi-turn — follow-up prompts can reference
    earlier results), so I can refine a question without starting over.
11. **As the person deploying this locally**, I want to configure which LLM
    provider/model and credential the assistant uses via configuration (env
    var, following the existing `PORT` convention), not hard-coded, so I can
    swap providers without a code change.

## 5. Functional requirements

Each requirement has an id, a short statement, and Given/When/Then
acceptance criteria.

### A. Chat interface

**FR-A1 — Prompt input and message stream.**
The assistant page presents a single-page chat UI: a scrollable message
history and a text input for the next prompt.
- *Given* the assistant page is loaded, *when* the user submits a
  non-empty prompt, *then* the prompt appears immediately in the message
  history as a "user" message and the input is cleared/disabled until a
  response starts.
- *Given* an empty or whitespace-only input, *when* the user tries to
  submit, *then* submission is a no-op (no message sent).

**FR-A2 — Streamed assistant responses.**
The assistant's textual reply streams into the UI token-by-token (or
chunk-by-chunk) rather than appearing all at once.
- *Given* a prompt that only needs an LLM text reply (no tool call),
  *when* the LLM streams its response, *then* the UI updates incrementally
  and a visual "assistant is responding" indicator is shown until the
  stream ends.

**FR-A3 — In-progress / tool-call status.**
While the assistant is deciding on or executing a tool call, the UI shows a
distinct status (e.g. "Calling `get_daily_sales_trend` on sales-insights…")
rather than a generic spinner.
- *Given* the LLM's response includes a tool call, *when* the assistant
  begins executing it, *then* the chat shows which tool and which server is
  being invoked before the result arrives.

**FR-A4 — Conversation history within a session.**
Prior turns (user prompts, assistant text, and a reference to any rendered
widget/tool result) remain visible and scrollable, and are included as
context for follow-up prompts within the same session.
- *Given* a user has asked a first question and received an answer,
  *when* they ask a follow-up that depends on the prior answer ("now show
  me just EMEA"), *then* the assistant has access to the prior turn when
  deciding its next tool call.
- *(Cross-session persistence is out of scope — see §7.)*

**FR-A5 — Error surfacing in-line.**
Failures (LLM API error, MCP server unreachable, tool execution error,
widget load failure) are shown as a distinct message in the chat stream,
not a silent failure or unhandled exception.
- *Given* a connected MCP server becomes unreachable mid-call, *when*
  the assistant attempts a tool call against it, *then* the chat shows an
  explicit error message identifying the server/tool, and the user can
  continue the conversation.

### B. LLM orchestration

**FR-B1 — Tool-calling loop.**
The assistant sends the user's prompt (plus conversation history and the
aggregated tool list from all connected/enabled MCP servers) to a
configured LLM using its native tool/function-calling mechanism, executes
any tool call(s) the LLM requests via the corresponding MCP server, feeds
the result back to the LLM, and returns the LLM's final natural-language
response.
- *Given* a prompt that matches an existing tool's description (e.g. "how
  did sales trend this month?"), *when* the assistant runs the loop,
  *then* `get_daily_sales_trend` is invoked with LLM-derived arguments and
  the final assistant message reflects the tool result.
- *Given* a prompt with no matching tool, *when* the assistant runs the
  loop, *then* the LLM answers directly without any tool call, and the UI
  does not display a tool-call status.

**FR-B2 — Configurable LLM provider/model/credential.**
The LLM provider, model name, and API credential are read from environment
configuration (mirroring the `PORT` convention in `server/main.ts`), not
hard-coded, and the server fails fast with a clear startup error if
required configuration is missing.
- *Given* the required LLM API key env var is unset, *when* the assistant
  process starts, *then* it logs a clear configuration error and does not
  silently fall back to a broken state.

**FR-B3 — Multiple/parallel tool calls per turn.**
A single user turn may result in the LLM requesting more than one tool
call (same or different servers); the assistant executes each and returns
all applicable results/widgets before finishing that turn.
- *Given* a prompt that reasonably maps to two tools (e.g. "show me the
  sales trend and the leaderboard"), *when* the assistant processes it,
  *then* both tool calls are executed and both results are shown in the
  same assistant turn.

**FR-B4 — Tool result truncation/size guard.**
Tool results (especially `structuredContent`) passed back into the LLM
context are size-bounded so a large payload from a misbehaving/arbitrary
MCP server cannot blow the LLM's context window or crash the request.
- *Given* a connected server returns an oversized tool result, *when* the
  assistant relays it back to the LLM, *then* the payload is truncated (or
  rejected with a surfaced error) per a documented limit rather than
  causing an unhandled failure.

### C. MCP server connection management

**FR-C1 — Default server pre-registered.**
On first load, this repo's own `sales-insights` MCP server is already
registered/connected, so the assistant is immediately useful without any
manual setup — consistent with this being a proof of concept the user can
open and try.
- *Given* a fresh session with no user-added servers, *when* the user asks
  "how did sales trend this month?", *then* the assistant can answer using
  the built-in server without any extra configuration step.

**FR-C2 — Add an MCP server (Streamable HTTP).**
The user can register an additional MCP server by supplying, at minimum, a
Streamable HTTP URL (e.g. `https://…/mcp`) and an optional display name.
The assistant connects, runs `tools/list`, and (if the handshake succeeds)
the new tools become available to the LLM on the next prompt.
- *Given* a valid, reachable MCP Streamable HTTP endpoint, *when* the user
  submits it via the "add server" UI, *then* the server appears in the
  connected-servers list with its discovered tools within a reasonable
  time (see NFR-Perf below), with no restart required.
- *Given* an unreachable URL or a URL that isn't a valid MCP endpoint,
  *when* the user submits it, *then* the UI shows a clear connection error
  and the server is not added to the active tool set.

**FR-C3 — List connected servers and their tools.**
A visible panel/list shows every connected server (name, connection
target, connection status) and, expandable per server, the tools it
exposes (tool name + description, mirroring what's shown in `tools/list`).
- *Given* two connected servers, *when* the user opens the servers panel,
  *then* both are listed with distinguishable identity (name) and status
  (connected / error / disabled).

**FR-C4 — Remove or disable a server.**
The user can remove a previously added server, or toggle it
disabled/enabled without deleting its configuration. A disabled/removed
server's tools are excluded from the next LLM tool-calling turn.
- *Given* a connected user-added server, *when* the user removes it,
  *then* subsequent prompts no longer offer its tools to the LLM, and any
  in-flight calls to it are handled per FR-A5 (error surfaced, not crashed).
- **Open question:** can the default `sales-insights` server be removed/
  disabled, or is it always-on? (See §8.)

**FR-C5 — Reconnect / resilience on server failure.**
If a previously-connected server becomes unreachable, its status updates
to reflect that (per FR-C3) rather than silently continuing to be offered
as available; the assistant does not crash or hang the whole chat when one
of several connected servers is down.
- *Given* one of two connected servers goes down, *when* the user submits
  a prompt that only needs the healthy server, *then* the assistant still
  answers successfully using the healthy server.

### D. MCP Apps widget rendering (the "host" role)

**FR-D1 — Render `ui://` widget results inline.**
When a tool call's result includes `_meta.ui.resourceUri`, the assistant
performs the MCP Apps handshake — reads the resource (widget HTML),
renders it in a sandboxed iframe, and pushes the tool result into it —
following the same protocol Claude Desktop uses today per
ARCHITECTURE.md's request-flow diagram (`ui/initialize`, tool result push,
`ui/callServerTool` on interaction).
- *Given* a tool call to `get_daily_sales_trend` succeeds, *when* the
  assistant has MCP Apps support for that resource, *then* the interactive
  line chart widget renders inline in the chat, matching the description
  in README.md ("interactive line chart, 7/30/90-day + region filters").

**FR-D2 — In-widget interactions call back through the assistant.**
When a rendered widget invokes a tool call (e.g. clicking a filter), the
assistant relays that call to the correct MCP server and pushes the fresh
result back to the same widget instance, without the user re-entering a
prompt or the page navigating away.
- *Given* a rendered trend widget, *when* the user clicks the "7D"
  filter inside it, *then* the widget updates in place with 7-day data,
  matching the behavior described in ARCHITECTURE.md §2's sequence
  diagram.

**FR-D3 — Iframe sandboxing / CSP for arbitrary widgets.**
Because user-added servers (FR-C2) are untrusted third parties (unlike the
bundled `sales-insights` widgets, which are built and shipped by this
repo), every rendered widget iframe is sandboxed by default (no top-level
navigation, no unsandboxed script privileges beyond what MCP Apps requires)
and a default-deny CSP is applied unless the resource declares an explicit,
narrower allowlist.
- *Given* a widget from a user-added server attempts to navigate the top
  window or load an arbitrary external script, *then* the sandbox/CSP
  blocks it and the chat surfaces a rendering error rather than allowing
  it silently.

**FR-D4 — Graceful fallback to text when no widget applies.**
If a tool result has no `_meta.ui.resourceUri`, or the resource fails to
load/initialize, or the widget itself errors after mounting, the assistant
renders the tool's `content` (markdown/plain text) instead — the same
fallback contract the server side already guarantees per
ARCHITECTURE.md §2 ("Every tool call always returns both `content`… and
`structuredContent`… which one the user sees is decided entirely by the
host"). This requirement is what makes *this* codebase, for the first
time, the thing making that decision.
- *Given* a tool result with no `_meta.ui.resourceUri`, *when* the
  assistant renders the turn, *then* the markdown `content` is shown
  (e.g. rendered as formatted text/tables), with no broken widget area.
- *Given* a widget resource that fails to load (network error, invalid
  HTML, handshake timeout), *when* the assistant detects the failure,
  *then* it falls back to rendering `content` and does not leave a blank
  or perpetually-loading widget slot.

**FR-D5 — Multiple widgets in one conversation.**
More than one rendered widget can coexist in the scrollback (e.g. one per
tool call across turns), each independently interactive per FR-D2, and
none affecting another's state.
- *Given* two prior turns each rendered a different widget, *when* the
  user interacts with the first widget's filter, *then* only that widget
  updates; the second is unaffected.

### E. Configuration & housekeeping

**FR-E1 — Server-list configuration surface.**
Server registration (FR-C2) is available through the UI at minimum; whether
it is also configurable via a startup file/env var (so a default set beyond
`sales-insights` can be pre-seeded) is an open question (§8) but the UI path
is required.

**FR-E2 — Reuse existing run conventions.**
The new assistant endpoint follows the existing process/config conventions
in this repo: an env-var-driven port (own var or a documented default
distinct from the existing `3001` server port, since both may run
simultaneously during development), a `--stdio`-style CLI flag pattern is
*not* applicable here (the assistant is a web UI, not a spawned MCP
process), but any new npm scripts follow the `npm run <verb>[:<detail>]`
naming already used (`serve`, `serve:stdio`, `build:trend`, …).

## 6. Non-functional requirements

**NFR-Perf-1 (responsiveness).** First token of an LLM response should
begin streaming to the UI within a few seconds under normal conditions for
a simple (no tool call) prompt; tool-call turns should show the "calling
tool" status (FR-A3) well before the tool itself returns, so the user
never sees a dead UI during the LLM's decision step.

**NFR-Perf-2 (server discovery).** Adding a new MCP server (FR-C2) should
complete `tools/list` discovery and update the UI within a few seconds for
a healthy endpoint; a slow/unresponsive endpoint should time out with a
visible error rather than hang the "add server" UI indefinitely.

**NFR-Security-1 (untrusted MCP servers).** User-added servers (FR-C2) are
untrusted input sources by definition ("users should be able to add *any*
mcp server"). At minimum: widget iframes are sandboxed and CSP-restricted
by default (FR-D3); tool results from any server are treated as untrusted
data when relayed back into the LLM context (never executed, never used to
alter the assistant's own configuration); and outbound connections the
assistant makes to a user-supplied URL are the user's own choice to make
(this POC does not implement an allowlist/approval gate — see §7/§8).

**NFR-Security-2 (credentials).** The LLM API key (FR-B2) and any
credentials for connecting to an MCP server (if a server requires auth —
out of scope to *build* per §7, but the design should not preclude it
later) are never logged, never sent to the browser, and never included in
data relayed to the LLM or to any connected MCP server other than the one
they belong to.

**NFR-Security-3 (prompt injection awareness).** Because tool results
(including from arbitrary user-added servers) are fed back into the LLM's
context, this is a known prompt-injection surface; this POC does not
attempt full mitigation, but tool results must be clearly delineated from
user/system content in the LLM request so the model can distinguish
"content returned by a tool" from "an instruction from the user," matching
the responsible baseline any MCP host should follow.

**NFR-Accessibility-1.** The chat UI (message list, input, server-management
panel) is keyboard-operable (tab order, submit via Enter, focus visible)
and uses semantic roles/labels sufficient for a screen reader to announce
new assistant messages and status changes, consistent with using the
existing `ui/shared/theme.css` design tokens for contrast rather than
inventing an unrelated palette.

**NFR-Compat-1.** The assistant UI runs in the same browser/host contexts
already implied by this project's audience (modern evergreen desktop
browsers); no requirement to support the sandboxed iframe rendering in a
non-browser embedding (e.g. inside another chat client) — that remains the
job of the *existing* MCP-server-only integration path.

**NFR-Reliability-1.** A failure in one connected MCP server (down,
erroring, slow) must not prevent the assistant from answering prompts that
don't need that server (FR-C5), and must not crash the assistant process
(matching the existing per-request isolation pattern in
`server/main.ts`'s Streamable HTTP handler, which creates a fresh server/
transport per request and cleans up on close).

**NFR-Observability-1.** Each tool call the assistant makes (server name,
tool name, arguments, success/failure, latency) is logged server-side at
minimum to the console, mirroring the existing `console.error("MCP
error:", …)` pattern in `server/main.ts`, so failures during a demo/dev
session are diagnosable without instrumenting anything new.

## 7. Out of scope (explicit)

- **AuthN/AuthZ** for the assistant page itself (no login) and for
  connections to user-added MCP servers (no credential/OAuth flow for
  servers that require auth) — this repo currently has zero auth anywhere
  (ARCHITECTURE.md §5), and this feature does not change that posture.
- **stdio-transport user-added servers.** "Add any MCP server" in this
  version means any *remote, Streamable-HTTP-reachable* MCP server. Adding
  a server that requires the assistant to spawn an arbitrary local process
  (stdio transport) from a web UI is a materially larger security surface
  (arbitrary local code execution triggered from a browser action) and is
  explicitly deferred — see open question in §8.
- **Persistence across sessions/restarts.** Conversation history and the
  list of user-added servers live only for the life of the running process
  (or, at most, browser session) — no database, no file-backed store. This
  matches the rest of the repo's "no I/O, no network, no auth" mock-data
  posture (ARCHITECTURE.md), extended here to "no persistence."
- **Multi-user / multi-tenant separation.** One assistant instance is
  assumed to serve one user's local session at a time; concurrent isolated
  users are not designed for here (see ARCHITECTURE.md §5's multi-tenancy
  section, still future work).
- **Row-level or role-based data scoping.** Not applicable at this layer —
  any such scoping remains the responsibility of individual MCP servers.
- **Governance/audit/PII controls** beyond basic logging (NFR-Observability-1)
  — full audit trails, masking policies, and compliance review remain
  future work per ARCHITECTURE.md §5.
- **Editing or deleting sent messages**, exporting/sharing a conversation,
  voice input, and non-English localization.
- **Approval/allowlisting workflow** for which MCP servers a user is
  *permitted* to add (e.g. an admin-curated registry) — any URL the user
  supplies can be added; there is no organizational gatekeeping in this
  version.
- **Changes to the existing `sales-insights` server's tools/behavior** —
  this feature only adds a client/host; `server/`, `ui/apps/*` remain as
  they are today except to the extent they need to be *reachable* as the
  default registered server.
- **Rate limiting, caching layers, and CI eval harnesses** for tool
  routing — called out as future hardening in ARCHITECTURE.md §5 and not
  part of this feature.

## 8. Open questions

1. **LLM provider.** Which LLM/provider should the assistant target first —
   Anthropic's API (thematically consistent with "Claude Desktop" being the
   primary tested host elsewhere in this repo), OpenAI, or a
   provider-agnostic abstraction? This determines the shape of FR-B1/FR-B2
   and what credential env var(s) are needed.
2. **stdio servers.** Is "add any MCP server" intended to include local
   stdio-spawned servers eventually, or is remote HTTP the full intended
   scope? (Recommendation in this draft: HTTP-only for v1, per §7.)
3. **Default server removability.** Can the user remove/disable the
   built-in `sales-insights` server (FR-C4), or is it always present as the
   demo anchor?
4. **Persistence.** Should the list of user-added servers survive a server
   restart (e.g. a JSON config file, similar in spirit to
   `server/mockData.ts`'s static config arrays), or is in-memory-only
   acceptable for this POC? Same question for conversation history.
5. **Human-in-the-loop tool approval.** Should the user be asked to confirm
   before the assistant executes a tool call — especially for tools on
   user-added (untrusted) servers — or is auto-execution (as Claude Desktop
   does today) acceptable for this POC?
6. **Deployment topology.** Does the assistant run as a new route/port
   alongside the existing `/mcp` Streamable HTTP endpoint in the same
   process (`server/main.ts`), or as a separate process/port? Both are
   consistent with "an endpoint" in the request, but affect FR-E2 and the
   dev-run instructions in README.md.
7. **Widget CSP for third-party servers.** For widgets from user-added
   servers, do we trust a server-declared `_meta.ui.csp` (per
   ARCHITECTURE.md §5's "Widget/CSP hardening" note, itself still future
   work even for the bundled widgets), or hard-code a maximally restrictive
   sandbox with no allowlist mechanism at all for v1?
8. **Tool-result size limit (FR-B4).** What's the concrete truncation
   threshold, and should the user be told truncation happened?
9. **Naming/location.** Should the new code live under a new top-level
   directory (e.g. `assistant/` for the client/orchestration backend,
   `ui/assistant/` for the chat frontend), following the existing
   `server/` + `ui/apps/<tool>` split, or under a different structure? (Not
   a requirement, but should be settled before design/implementation.)

## 9. Acceptance criteria summary (traceability)

| Requirement | Primary acceptance signal |
|---|---|
| FR-A1–A5 | Manual/UI test: prompt submission, streaming, status states, error states all observable in the chat |
| FR-B1–B4 | Given a known prompt, the correct tool(s) fire with correct args, and multi-tool/oversized-result edge cases are handled without crashing |
| FR-C1–C5 | Server list UI reflects add/remove/disable/failure accurately and promptly |
| FR-D1–D5 | Widget renders and stays interactive for built-in tools; falls back to text on missing/broken widget; sandbox blocks unsafe iframe behavior |
| NFR-Perf-1/2 | Time-to-first-token and time-to-tools-list measured under normal conditions |
| NFR-Security-1/2/3 | Manual review: no credential leakage, iframe sandbox attributes present, tool-result delineation present in LLM request payloads |
| NFR-Accessibility-1 | Keyboard-only walkthrough of chat + server panel; screen-reader spot check |
| NFR-Reliability-1 | Kill one of two connected servers mid-session; assistant remains usable for the healthy one |
| NFR-Observability-1 | Tool calls appear in server console logs during a manual session |
