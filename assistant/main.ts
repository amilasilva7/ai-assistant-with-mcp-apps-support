/**
 * Entry point for the assistant backend.
 *   npm run serve:assistant  -> http://127.0.0.1:3002
 *
 * Startup order follows design §3.4: config -> SPA build check (fatal) ->
 * widget bundle check (warn) -> registry -> bind guard -> listen.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "./config.js";
import { initLogging, logError } from "./log.js";
import { ServerRegistry } from "./registry.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { BedrockProvider } from "./llm/bedrock.js";
import { GeminiProvider } from "./llm/gemini.js";
import { OllamaProvider } from "./llm/ollama.js";
import type { LlmProvider } from "./llm/provider.js";
import { SessionStore } from "./session.js";
import { createChatRouter } from "./routes/chat.js";
import { createServersRouter } from "./routes/servers.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createEventsRouter } from "./routes/events.js";

const ROOT_DIR = path.join(import.meta.dirname, "..");
const SPA_DIR = path.join(ROOT_DIR, "dist", "assistant");
const WIDGET_DIR = path.join(ROOT_DIR, "dist", "ui");

// The assistant's own SPA CSP (review R-6: the design left this dangling).
// It must permit the `srcdoc` child iframes the host creates for widgets —
// `frame-src 'self'` (not 'none') is what makes that safe: it does not
// restrict *content* injected via `srcdoc` (there is no cross-origin
// navigation to check), it just avoids leaving the directive wide open.
//
// `script-src` includes 'unsafe-inline' and `img-src` includes `blob:` for a
// reason the original design missed: per the CSP spec's "inherit a policy"
// algorithm, an `about:srcdoc` document enforces the CREATING document's CSP
// *in addition to* (ANDed with, not replaced by) any policy it declares
// itself via a `<meta>` tag — confirmed empirically (a plain `script-src
// 'self'` here silently blocked every widget's own inline bundle script,
// even though host/sandbox.ts injects a correct per-widget meta CSP with
// `script-src 'unsafe-inline'` into the srcdoc content; there is no HTML
// attribute to opt an iframe out of this inheritance). Loosening it here is
// safe for *this* page specifically because the SPA renders all dynamic
// content (chat text, tool results) as React elements — nowhere in
// ui/assistant/ uses dangerouslySetInnerHTML, innerHTML, or eval — so there
// is no known path for untrusted text to become executable inline script on
// this page. The widget's own isolation (opaque-origin sandbox, connect-src
// 'none') is what actually contains a hostile widget (§8.3); this directive
// exists for defense-in-depth on the host page, not as the widget sandbox.
const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function widgetFileNameFromResourceUri(resourceUri: string): string | undefined {
  try {
    const u = new URL(resourceUri);
    const segments = u.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1];
  } catch {
    return undefined;
  }
}

async function main() {
  const config = loadConfig();
  initLogging(config);

  if (!existsSync(path.join(SPA_DIR, "index.html"))) {
    console.error(
      `Fatal: ${path.join(SPA_DIR, "index.html")} not found. Run "npm run build" (or "npm run build:assistant") first.`,
    );
    process.exit(1);
  }

  if (config.bind !== "127.0.0.1" && config.bind !== "localhost") {
    console.warn(
      [
        "",
        "*** ASSISTANT_BIND is not loopback — the assistant will accept connections from other hosts. ***",
        "  Risk 1: anyone who can reach this port can spend your ANTHROPIC_API_KEY's credits.",
        "  Risk 2: this process can be used as an SSRF pivot to any URL a user asks it to add as a server.",
        "  Only do this on a network you trust.",
        "",
      ].join("\n"),
    );
  }

  const registry = new ServerRegistry(config);
  await registry.connectBuiltin();

  const buildWarnings: string[] = [];
  const builtin = registry.get("sales-insights");
  if (builtin) {
    for (const tool of builtin.tools) {
      if (!tool.resourceUri) continue;
      const fileName = widgetFileNameFromResourceUri(tool.resourceUri);
      const exists = fileName ? existsSync(path.join(WIDGET_DIR, fileName)) : false;
      if (!exists) {
        tool.widgetUnavailable = true;
        const msg = `widget bundle not built for "${tool.name}" (expected dist/ui/${fileName ?? "?"}) — run "npm run build"`;
        buildWarnings.push(msg);
        console.warn(`[main] ${msg}`);
      }
    }
  }

  for (const seed of config.seedServers) {
    try {
      await registry.addHttp(seed.url, seed.name, seed.headers);
    } catch (err) {
      logError("main:seed", err);
    }
  }

  const llm: LlmProvider =
    config.llmProvider === "gemini"
      ? new GeminiProvider(config.geminiApiKey, config.model, config.maxOutputTokens)
      : config.llmProvider === "ollama"
        ? new OllamaProvider(config.ollamaBaseUrl, config.model)
        : config.llmProvider === "bedrock"
          ? new BedrockProvider(config.awsRegion, config.model, config.maxOutputTokens)
          : new AnthropicProvider(config.anthropicApiKey, config.model, config.maxOutputTokens);
  console.log(`[main] LLM provider: ${config.llmProvider} (${config.model})`);
  const sessions = new SessionStore();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // §8.1 network posture: no cors() (contrast server/main.ts, which needs
  // it), loopback bind by default, and an Origin/Host guard that rejects the
  // DNS-rebinding class of attacks the MCP SDK's own transport guards
  // against. ASSISTANT_PUBLIC_ORIGIN widens this to one additional exact
  // origin (e.g. a cloudflared tunnel's https://xxxx.trycloudflare.com) —
  // still an allowlist of specific origins, not a wildcard.
  const publicOriginUrl = config.publicOrigin ? new URL(config.publicOrigin) : null;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        ok =
          ((o.hostname === "127.0.0.1" || o.hostname === "localhost") && o.port === String(config.port)) ||
          (publicOriginUrl !== null && o.origin === publicOriginUrl.origin);
      } catch {
        ok = false;
      }
      if (!ok) {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
    }
    const hostHeader = (req.headers.host ?? "").split(":")[0];
    const publicHostname = publicOriginUrl?.hostname;
    if (hostHeader !== "127.0.0.1" && hostHeader !== "localhost" && hostHeader !== publicHostname) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    next();
  });

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", SPA_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      model: config.model,
      widgetInitTimeoutMs: config.widgetInitTimeoutMs,
      maxToolIterations: config.maxToolIterations,
      buildWarnings,
    });
  });

  app.post("/api/session", (_req, res) => {
    const session = sessions.create();
    res.json({ sessionId: session.id });
  });

  app.use("/api", createChatRouter({ sessions, registry, llm, config }));
  app.use("/api", createServersRouter(registry));
  app.use("/api", createMcpRouter({ sessions, registry, config }));
  app.use("/api", createEventsRouter(registry));

  app.use(express.static(SPA_DIR));
  // Express 5's router (path-to-regexp v6+) rejects a bare "*" wildcard; a
  // regex route matches every remaining GET so client-side routing (if any
  // is ever added) still resolves to index.html.
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(SPA_DIR, "index.html"));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError("http", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const server = app.listen(config.port, config.bind, () => {
    console.log(`Assistant listening on http://${config.bind}:${config.port}`);
  });

  process.on("SIGINT", () => {
    console.log("Shutting down…");
    server.close();
    registry
      .closeAll()
      .catch((err) => logError("shutdown", err))
      .finally(() => process.exit(0));
  });

  // A POC that dies because one user-added server threw during a stream
  // fails NFR-Reliability-1 harder than a logged-and-continued error does.
  process.on("unhandledRejection", (err) => logError("unhandledRejection", err));
  process.on("uncaughtException", (err) => logError("uncaughtException", err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
