# Sales Insights MCP (POC)

A proof-of-concept [MCP](https://modelcontextprotocol.io) server for an internal
presentation: a marketing/sales user asks their AI assistant a natural-language
question about daily sales, and gets back an **interactive chart rendered inline
in the chat**, via the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
extension (SEP-1865) — with a clean markdown fallback for hosts that don't
support MCP Apps.

> For component breakdown, request flow diagrams, configuration reference, and
> a roadmap to a real enterprise deployment (auth, real data, governance), see
> [ARCHITECTURE.md](./ARCHITECTURE.md).

All data is mocked (deterministic, generated at server start). There is no real
API, database, or auth — this is a demo, not a product.

## Tools

| Tool | Natural-language example | Widget |
|---|---|---|
| `get_daily_sales_trend` | "How did sales trend this month?" | Line chart, 7/30/90-day + region filters |
| `get_sales_by_region` | "Break down sales by region" | Bar chart, revenue/orders + channel split toggle |
| `get_top_products` | "What are our top 5 products?" | Ranked bar chart, top 5/10 |
| `get_sales_leaderboard` | "Who are the top performing reps?" | Ranked bar chart, top 5/10 |

Every tool returns **both**: a markdown summary/table in `content` (what any
MCP host shows) and an interactive widget via `_meta.ui.resourceUri` (what a
host with MCP Apps support renders instead). Widgets are fully interactive —
their filter controls call back into the server (`app.callServerTool`) for
fresh data without leaving the chat.

## Project layout

```
server/
  mockData.ts   deterministic mock dataset + per-tool aggregation
  format.ts     markdown fallback formatters
  server.ts     registers the 4 tools + their ui:// resources
  main.ts       entry point (stdio or Streamable HTTP)
ui/
  shared/       theme, chart components (SVG bar/line), hooks
  apps/*/       one React entry per widget
  *.html        vite entry points, bundled to a single self-contained HTML file
```

## Setup

```bash
npm install
npm run build      # bundles the 4 widgets into dist/ui/*.html
```

## Running

```bash
npm run serve         # Streamable HTTP on http://localhost:3001/mcp
npm run serve:stdio   # stdio transport
```

### Testing with Claude Desktop (stdio, no tunnel needed)

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "sales-insights": {
      "command": "npx",
      "args": ["tsx", "server/main.ts", "--stdio"],
      "cwd": "D:\\Projects\\IDEA-PROJECTS\\income-mcp"
    }
  }
}
```

Restart Claude Desktop, then ask e.g. "show me the daily sales trend for the
last 90 days" or "who's leading the sales leaderboard".

### Testing with the ext-apps basic-host (fastest iteration loop)

```bash
git clone https://github.com/modelcontextprotocol/ext-apps.git
cd ext-apps/examples/basic-host
npm install
SERVERS='["http://localhost:3001/mcp"]' npm start
```

Then open `http://localhost:8080` (with `npm run serve` running in this repo).

### Testing with Claude (web) / ChatGPT / Copilot (remote HTTP connector)

These hosts need a reachable HTTPS URL. For local development, tunnel the
Streamable HTTP server:

```bash
npm run serve
npx cloudflared tunnel --url http://localhost:3001
```

Add the resulting URL (`https://<random>.trycloudflare.com/mcp`) as a custom
connector in the host. Claude Desktop/web and VS Code Copilot currently render
MCP Apps widgets; hosts without MCP Apps support (or where the feature isn't
enabled) will fall back to the markdown table/summary automatically — that's
the graceful-degradation path this POC is built to demonstrate.

## AI Assistant (chat UI, port 3002)

A second, separate piece of this repo: a standalone chat UI that talks to an
LLM, calls tools on any number of MCP servers (this one included), and
renders their widgets inline — with a pluggable LLM backend (Anthropic,
Gemini, AWS Bedrock, or a local Ollama model, switchable via one env var) and
support for adding arbitrary MCP servers at runtime. Independent of
everything above — runs on its own port, doesn't require `npm run serve`.

```bash
npm run build && npm run assistant   # http://127.0.0.1:3002
```

Full setup reference — switching providers, running a model locally with
Docker to sidestep API rate limits, adding MCP servers, tunneling,
troubleshooting — is in **[ASSISTANT.md](./ASSISTANT.md)**.

## Notes for the presentation

- **Cross-host compatibility is aspirational, not guaranteed** — MCP Apps
  (SEP-1865) shipped as an official MCP extension in January 2026 and client
  support is still rolling out unevenly. Claude Desktop currently has the most
  mature support; treat the other hosts as "same server, same tools, same
  fallback text" even if the interactive widget doesn't render there yet.
- All four tools are interactive widgets (per POC scope), but the fallback
  text is what proves the server works everywhere regardless of UI support.
- The mock dataset is seeded, so numbers are stable across runs/demos.
