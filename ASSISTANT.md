# AI Assistant — setup & configuration reference

A standalone chat UI (separate from the MCP server on port 3001) that talks to
an LLM, calls tools on any number of MCP servers, and renders their widgets
inline in the conversation. Runs on **port 3002**, entirely independent of
`npm run serve` — you can run both at once.

This doc is the practical "how do I start it with X configuration" reference.
For the *design* (architecture, security model, request flow), see
[`.claude/requirements/ai-assistant-with-ui-rendering-capability/001-design.md`](.claude/requirements/ai-assistant-with-ui-rendering-capability/001-design.md).

## Contents

- [Quick start](#quick-start)
- [Switching LLM providers](#switching-llm-providers)
  - [Anthropic (default)](#anthropic-default)
  - [Gemini](#gemini)
  - [Ollama — local model, no rate limits](#ollama--local-model-no-rate-limits)
  - [AWS Bedrock](#aws-bedrock)
- [Adding MCP servers](#adding-mcp-servers)
- [Tunneling with Cloudflare](#tunneling-with-cloudflare)
- [Command reference](#command-reference)
- [Common configurations, copy-paste](#common-configurations-copy-paste)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Quick start

```bash
npm install
cp .env.example .env      # then set ANTHROPIC_API_KEY in .env
npm run build              # bundles the 4 widgets + the assistant SPA
npm run assistant           # http://127.0.0.1:3002
```

Everything below is variations on this: which provider, which MCP servers,
whether it's tunneled to a public URL.

`.env` holds every setting (`assistant/config.ts` reads it once at startup —
**changing `.env` always requires restarting `npm run assistant`** to take
effect). `.env.example` is the committed template with every variable
documented; `.env` is gitignored — that's where real keys belong, never in
`.env.example`.

## Switching LLM providers

Set `ASSISTANT_LLM_PROVIDER` in `.env` to one of `anthropic` (default),
`gemini`, `ollama`, or `bedrock`. Only the selected provider's key is
required — this runs one provider at a time, not a fallback chain. Restart
`npm run assistant` after changing it.

### Anthropic (default)

```bash
# .env
ASSISTANT_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# ASSISTANT_MODEL=claude-sonnet-4-5-20250929   # default if unset — verify against
                                                # console.anthropic.com before relying on it
```

Get a key at [console.anthropic.com](https://console.anthropic.com/).

### Gemini

```bash
# .env
ASSISTANT_LLM_PROVIDER=gemini
GEMINI_API_KEY=AQ....
# ASSISTANT_MODEL=gemini-3.6-flash   # default if unset — verify against aistudio.google.com
```

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### Ollama — local model, no rate limits

Runs a model on your own machine via Docker. No API key, no per-request cost,
no rate limit — useful specifically when Anthropic/Gemini quota is blocking
POC development. Tradeoff: noticeably slower per turn without a GPU (expect
25s–60s+ on CPU for an 8B model), and small models are less reliable at
producing well-typed tool arguments than Claude/Gemini (the assistant
compensates for common cases — see [Limitations](#limitations)).

**One-command path** — does everything below automatically (start/reuse the
container, pull the model if missing, update `.env`, build, start the
assistant, open a tunnel and wire it up):

```bash
scripts/start-with-ollama.sh              # full stack incl. Cloudflare tunnel
scripts/start-with-ollama.sh --no-tunnel  # local only, http://localhost:3002

# use a different model:
OLLAMA_MODEL=llama3.1:70b scripts/start-with-ollama.sh
```

Safe to re-run any time — reuses the container/model if already present, and
only updates the `.env` lines it owns.

**Manual path**, if you'd rather run each step yourself:

```bash
# 1. Start Ollama in Docker (persists pulled models in the 'ollama-data' volume)
docker run -d --name ollama -p 11434:11434 -v ollama-data:/root/.ollama ollama/ollama

# 2. Pull a model into it (one-time; ~4.9GB for the 8b model)
docker exec ollama ollama pull llama3.1:8b

# 3. Point .env at it
```
```bash
# .env
ASSISTANT_LLM_PROVIDER=ollama
ASSISTANT_MODEL=llama3.1:8b
OLLAMA_BASE_URL=http://localhost:11434
```
```bash
# 4. Build + start as usual
npm run build
npm run assistant
```

Useful day-to-day commands once the container exists:

```bash
docker ps --filter name=ollama          # is it running?
docker start ollama                     # (re)start it after a reboot
docker exec ollama ollama list          # which models are pulled
docker exec ollama ollama pull <model>  # pull another one, e.g. llama3.1:70b
docker stop ollama                      # stop it (data persists in the volume)
docker logs ollama                      # its own logs
```

Any [Ollama model that supports tool calling](https://ollama.com/search?c=tool)
should work (Llama 3.1/3.3, Qwen 3, Mistral Small 3.1, and others) — set
`ASSISTANT_MODEL` accordingly and pull it first.

### AWS Bedrock

Runs Claude through your AWS account instead of an Anthropic API key — useful
if your organization already has AWS billing/IAM set up for Bedrock, or needs
requests to stay inside AWS. Uses the Mantle client
(`@anthropic-ai/bedrock-sdk`), which speaks the same Messages API shape as the
first-party Anthropic SDK.

```bash
# .env
ASSISTANT_LLM_PROVIDER=bedrock
AWS_REGION=us-east-1
# ASSISTANT_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0   # default if unset — verify
                                                                # against the Bedrock model
                                                                # catalog for your region
```

There's no `ASSISTANT_`-specific key for Bedrock — only `AWS_REGION` (or
`AWS_DEFAULT_REGION`) is required, and that's the standard AWS SDK region
variable, not something this repo invented. AWS credentials themselves are
resolved by the normal AWS credential chain, in this order: an
`AWS_BEARER_TOKEN_BEDROCK` bearer token, then `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the default provider chain
(`~/.aws/credentials`, SSO, or an EC2/ECS/Lambda role) — whatever your `aws`
CLI already uses will work here too, with no extra config in `.env`.

Two things to check in the AWS Console before it'll work:

- **Model access** — Bedrock, unlike a plain Anthropic API key, requires
  explicitly granting access to each model per account/region: **Bedrock ->
  Model access -> Manage model access**, enable the Claude model you intend to
  use, and confirm it's available in the region you set `AWS_REGION` to (not
  every Claude model is in every region).
- **IAM permissions** — whichever credential you're using needs
  `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` (or an
  equivalent managed policy like `AmazonBedrockFullAccess`) for the model ARN
  you're calling.

Model IDs on Bedrock are AWS's own catalog IDs, not Anthropic's — they carry
an `anthropic.` prefix and a `-vN:0` suffix (e.g.
`anthropic.claude-sonnet-4-5-20250929-v1:0`), sometimes with a region prefix
too for cross-region inference profiles (e.g. `us.anthropic.claude-...`).
Copy the exact ID from the Bedrock console's model catalog for your region
rather than guessing one from the Anthropic model name.

## Adding MCP servers

The built-in `sales-insights` server (this repo's own 4 tools) is always
connected and can't be removed (only disabled) — see `assistant/config.ts`'s
`D-8` note. To add more:

**At runtime**, via the UI: open the assistant, click **Panel** (top right) to
expand the side panel, and use the "Add server" form under **MCP servers** —
paste a Streamable HTTP MCP endpoint URL (e.g.
`http://localhost:3001/mcp` — this repo's own server, if you have `npm run
serve` running separately, is a realistic test target). Added servers are
untrusted (`trust: "user"`): their first tool call in a session prompts for
approval, and their widgets render under a stricter default-deny sandbox
regardless of what the server itself declares.

**At startup**, via a read-only seed (no UI interaction needed, e.g. for a
repeatable demo setup):

```bash
# .env — JSON array, one entry per server
ASSISTANT_SERVERS=[{"name":"local mcp","url":"http://localhost:3001/mcp"}]
```

Seeded servers are still `trust: "user"` and still require the first-use
approval prompt — the seed only saves you re-typing the URL every restart.
Nothing is persisted across restarts beyond this env var; servers added
through the UI vanish when the process restarts.

## Tunneling with Cloudflare

For sharing a running instance with someone else, or connecting from a device
that isn't this machine. `ASSISTANT_BIND` stays `127.0.0.1` — `cloudflared`
runs locally and proxies the public URL back to loopback, so the port never
needs to actually open.

```bash
npm run assistant                                      # terminal 1
npx cloudflared tunnel --url http://localhost:3002      # terminal 2
```

Cloudflare prints a URL like `https://<random-words>.trycloudflare.com`. The
assistant's Origin/Host guard will `403` every request through it until you
tell it to trust that origin:

```bash
# .env
ASSISTANT_PUBLIC_ORIGIN=https://<random-words>.trycloudflare.com
```

Then **restart** `npm run assistant` (this is read once at startup). Free
Cloudflare "quick tunnels" get a new random URL every time `cloudflared`
restarts — there's no way to keep the same link across runs without a paid
named tunnel — so this env var needs updating each session.

`scripts/start-with-ollama.sh` automates this whole handshake (start → detect
the printed URL → write it to `.env` → restart) — worth using as a template
even if you're not using Ollama that day.

**What this does and doesn't protect:** the assistant has no login of its
own. Anyone with the tunnel URL has full access — they can chat using
whichever LLM key is configured, and add MCP servers (a potential SSRF
pivot). The unguessable tunnel subdomain is the only thing standing between
"private" and "public." Don't leave a tunnel running unattended longer than
you need it.

## Command reference

| Command | What it does |
|---|---|
| `npm run build` | Builds all 4 widget bundles (`dist/ui/*.html`) **and** the assistant SPA (`dist/assistant/`). Required before `npm run assistant` will even start. |
| `npm run assistant` | Starts the assistant on `ASSISTANT_PORT` (default 3002). Reads `.env` once at startup. |
| `npm run dev:assistant` | Vite dev server for the assistant SPA only (fast frontend iteration) — proxies API calls to a separately-running `npm run assistant`. |
| `npm run serve` | The original MCP server on port 3001 (independent of the assistant; useful as a test "add server" target, or for Claude Desktop/ChatGPT/Copilot connectors — see [README.md](./README.md)). |
| `npm run serve:stdio` | Same server over stdio, for a Claude Desktop config entry. |
| `npm run typecheck` | `tsc --noEmit` across the whole repo — the one automated gate that exists (no test runner). |
| `scripts/start-with-ollama.sh [--no-tunnel]` | Full Ollama-backed stack in one command — see [above](#ollama--local-model-no-rate-limits). |

## Common configurations, copy-paste

**Local dev, Claude, no tunnel** (default):
```bash
# .env: ASSISTANT_LLM_PROVIDER=anthropic, ANTHROPIC_API_KEY=...
npm run build && npm run assistant
```

**Local dev, free/unlimited local model, no tunnel:**
```bash
scripts/start-with-ollama.sh --no-tunnel
```

**Demo for someone remote, Gemini, tunneled:**
```bash
# .env: ASSISTANT_LLM_PROVIDER=gemini, GEMINI_API_KEY=...
npm run build && npm run assistant   # terminal 1
npx cloudflared tunnel --url http://localhost:3002   # terminal 2
# copy the printed URL into .env as ASSISTANT_PUBLIC_ORIGIN, then restart terminal 1
```

**Full local-model demo, tunneled, one command:**
```bash
scripts/start-with-ollama.sh
```

**Testing multi-server routing** (this repo's own server as a second, "user-added" MCP server):
```bash
npm run serve                          # terminal 1 — port 3001
npm run assistant                      # terminal 2 — port 3002
# then in the assistant UI: Panel -> Add server -> http://localhost:3001/mcp
```

## Troubleshooting

- **`Widget could not be shown (widget did not initialize within 5000ms)`** —
  should not happen on a current build; this was a real CSP bug (fixed) where
  the parent page's `script-src` blocked every widget's inline script. If you
  see it again, check the browser console for a CSP violation before assuming
  it's something else.
- **`403 {"error":"Origin not allowed"}` / `"Host not allowed"`** — you're
  hitting the assistant through a tunnel URL that isn't in `ASSISTANT_PUBLIC_ORIGIN`
  yet. See [Tunneling](#tunneling-with-cloudflare).
- **Assistant won't start, complains about a missing SPA** — run `npm run
  build` first; `dist/assistant/index.html` is a hard startup precondition.
- **Port 3002 (or 3001, or 11434) already in use** — a previous run's process
  is still alive. `netstat -ano | grep :3002` (Windows) then `taskkill /F /PID
  <pid>` — on Windows, `npm run assistant` spawns a real `node.exe` child that
  can outlive a plain `kill` of the npm wrapper, so go straight for the PID
  actually bound to the port rather than whatever PID the shell reports.
- **Rate-limited / "Anthropic rejected" / "Gemini rate-limited"** — this is
  the whole reason the Ollama path exists; switch providers per
  [above](#switching-llm-providers).
- **Ollama tool call fails with a schema/validation error** — the model sent
  a malformed argument (e.g. a string where a number was expected). The
  assistant already repairs the common cases (`assistant/tools.ts`'s
  `coerceToolArgs`); if you hit a new pattern, retry the prompt — small
  models are simply less reliable at this than Claude/Gemini, and this isn't
  fully eliminable.

## Limitations

- **No persistence.** Everything is in-memory — sessions, added servers, tool
  approvals. A restart clears all of it (`ASSISTANT_SERVERS` seed excepted).
- **One provider at a time**, no fallback chain.
- **Ollama's tool-calling reliability is model-dependent.** Larger/more
  recent Ollama models generally do better; 8B-class models occasionally send
  malformed arguments even with the coercion safety net.
- **This is a POC**, not hardened for production: no auth beyond loopback-or-
  allowlisted-origin, no rate limiting beyond basic per-widget/per-session
  caps, no audit logging beyond console output.
