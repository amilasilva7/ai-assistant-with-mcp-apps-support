import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getDailyTrend,
  getSalesByRegion,
  getSalesLeaderboard,
  getTopProducts,
  REGIONS,
} from "./mockData.js";
import { formatLeaderboard, formatProducts, formatRegion, formatTrend } from "./format.js";

const DIST_DIR = path.join(import.meta.dirname, "..", "dist");

const REGION_NAMES = REGIONS.map((r) => r.name) as [string, ...string[]];

async function readWidgetHtml(fileName: string): Promise<string> {
  // vite preserves the source path (ui/<name>.html) under dist/.
  return fs.readFile(path.join(DIST_DIR, "ui", fileName), "utf-8");
}

function registerWidget(
  server: McpServer,
  opts: {
    resourceUri: string;
    htmlFile: string;
  },
) {
  registerAppResource(
    server,
    opts.resourceUri,
    opts.resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await readWidgetHtml(opts.htmlFile);
      return { contents: [{ uri: opts.resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    },
  );
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Sales Insights (POC)",
    version: "0.1.0",
  });

  // --- Daily sales trend --------------------------------------------------
  const trendUri = "ui://sales-insights/trend.html";
  registerAppTool(
    server,
    "get_daily_sales_trend",
    {
      title: "Daily Sales Trend",
      description:
        "Shows how daily sales revenue has trended over a recent period (e.g. 'how did sales trend this month', " +
        "'show me the last 90 days of sales', 'how are we doing this week'). Optionally scoped to one region. " +
        "Returns an interactive line chart plus a text summary.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(7)
          .max(180)
          .optional()
          .describe("Number of trailing days to show. Defaults to 30. Common values: 7, 30, 90."),
        region: z
          .enum(REGION_NAMES)
          .optional()
          .describe("Restrict the trend to a single region. Omit for all regions combined."),
      },
      _meta: { ui: { resourceUri: trendUri } },
    },
    async ({ days, region }): Promise<CallToolResult> => {
      const data = getDailyTrend(days ?? 30, region ?? null);
      return {
        content: [{ type: "text", text: formatTrend(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
  registerWidget(server, { resourceUri: trendUri, htmlFile: "trend.html" });

  // --- Sales by region / channel ------------------------------------------
  const regionUri = "ui://sales-insights/region.html";
  registerAppTool(
    server,
    "get_sales_by_region",
    {
      title: "Sales by Region",
      description:
        "Breaks down sales by region (North America, EMEA, APAC, LATAM), e.g. 'break down sales by region', " +
        "'which region is winning', 'compare regions by orders'. Can optionally split each region by sales " +
        "channel (Online / Retail / Wholesale). Returns an interactive bar chart plus a text summary.",
      inputSchema: {
        days: z.number().int().min(7).max(180).optional().describe("Trailing days to aggregate. Defaults to 30."),
        metric: z.enum(["revenue", "orders"]).optional().describe("Metric to compare. Defaults to revenue."),
        splitByChannel: z
          .boolean()
          .optional()
          .describe("If true, break each region down by sales channel. Only applies to the revenue metric."),
      },
      _meta: { ui: { resourceUri: regionUri } },
    },
    async ({ days, metric, splitByChannel }): Promise<CallToolResult> => {
      const data = getSalesByRegion(days ?? 30, metric ?? "revenue", splitByChannel ?? false);
      return {
        content: [{ type: "text", text: formatRegion(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
  registerWidget(server, { resourceUri: regionUri, htmlFile: "region.html" });

  // --- Top products ---------------------------------------------------------
  const productsUri = "ui://sales-insights/products.html";
  registerAppTool(
    server,
    "get_top_products",
    {
      title: "Top Products",
      description:
        "Ranks products/SKUs by revenue over a recent period, e.g. 'what are our top 5 products', " +
        "'best sellers this month'. Returns an interactive ranked bar chart plus a text summary.",
      inputSchema: {
        days: z.number().int().min(7).max(180).optional().describe("Trailing days to aggregate. Defaults to 30."),
        topN: z.number().int().min(3).max(10).optional().describe("How many products to return. Defaults to 5."),
      },
      _meta: { ui: { resourceUri: productsUri } },
    },
    async ({ days, topN }): Promise<CallToolResult> => {
      const data = getTopProducts(days ?? 30, topN ?? 5);
      return {
        content: [{ type: "text", text: formatProducts(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
  registerWidget(server, { resourceUri: productsUri, htmlFile: "products.html" });

  // --- Sales rep leaderboard -------------------------------------------------
  const leaderboardUri = "ui://sales-insights/leaderboard.html";
  registerAppTool(
    server,
    "get_sales_leaderboard",
    {
      title: "Sales Rep Leaderboard",
      description:
        "Ranks sales reps by revenue closed over a recent period, e.g. 'who are the top performing reps', " +
        "'show me the sales leaderboard'. Returns an interactive ranked bar chart plus a text summary.",
      inputSchema: {
        days: z.number().int().min(7).max(180).optional().describe("Trailing days to aggregate. Defaults to 30."),
        topN: z.number().int().min(3).max(10).optional().describe("How many reps to return. Defaults to 5."),
      },
      _meta: { ui: { resourceUri: leaderboardUri } },
    },
    async ({ days, topN }): Promise<CallToolResult> => {
      const data = getSalesLeaderboard(days ?? 30, topN ?? 5);
      return {
        content: [{ type: "text", text: formatLeaderboard(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
  registerWidget(server, { resourceUri: leaderboardUri, htmlFile: "leaderboard.html" });

  return server;
}
