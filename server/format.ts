/**
 * Markdown fallbacks. Every tool returns this text in `content` regardless of
 * host, so a client with no MCP Apps support (or a user who prefers text)
 * still gets a complete, readable answer.
 */
import type { LeaderboardResult, ProductResult, RegionResult, TrendResult } from "./mockData.js";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function fmtCurrency(n: number): string {
  return currency.format(n);
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export function formatTrend(data: TrendResult): string {
  const scope = data.region ? `${data.region} daily sales` : "Daily sales (all regions)";
  const lines = [`**${scope} — last ${data.days} days**`, ""];
  lines.push(`- Total revenue: ${fmtCurrency(data.totalRevenue)}`);
  lines.push(`- Average per day: ${fmtCurrency(data.avgDailyRevenue)}`);
  if (data.pctChangeVsPrior !== null) {
    lines.push(`- vs. prior ${data.days}-day period: ${fmtPct(data.pctChangeVsPrior)}`);
  }
  lines.push("", "| Date | Revenue |", "|---|---|");
  const recent = data.points.slice(-10);
  for (const p of recent) {
    lines.push(`| ${p.date} | ${fmtCurrency(p.revenue)} |`);
  }
  if (data.points.length > recent.length) {
    lines.push("", `_Showing the last ${recent.length} of ${data.points.length} days; the chart above (or attached widget) shows the full range._`);
  }
  return lines.join("\n");
}

export function formatRegion(data: RegionResult): string {
  const metricLabel = data.metric === "revenue" ? "Revenue" : "Orders";
  const total = data.rows.reduce((s, r) => s + r.value, 0);
  const lines = [`**Sales by region — ${metricLabel.toLowerCase()}, last ${data.days} days**`, ""];

  if (data.splitByChannel) {
    lines.push(`| Region | ${data.channels.join(" | ")} | Total | Share |`, `|---|${data.channels.map(() => "---").join("|")}|---|---|`);
    for (const row of data.rows) {
      const channelCells = data.channels.map((c) => fmtCurrency(row.byChannel?.[c] ?? 0)).join(" | ");
      const share = total > 0 ? (row.value / total) * 100 : 0;
      lines.push(`| ${row.region} | ${channelCells} | ${fmtCurrency(row.value)} | ${share.toFixed(0)}% |`);
    }
  } else {
    lines.push("| Region | " + metricLabel + " | Share |", "|---|---|---|");
    for (const row of data.rows) {
      const share = total > 0 ? (row.value / total) * 100 : 0;
      const value = data.metric === "revenue" ? fmtCurrency(row.value) : row.value.toLocaleString("en-US");
      lines.push(`| ${row.region} | ${value} | ${share.toFixed(0)}% |`);
    }
  }
  return lines.join("\n");
}

export function formatProducts(data: ProductResult): string {
  const lines = [`**Top ${data.rows.length} products — last ${data.days} days**`, "", "| Rank | Product | Revenue | Units |", "|---|---|---|---|"];
  for (const row of data.rows) {
    lines.push(`| ${row.rank} | ${row.product} | ${fmtCurrency(row.revenue)} | ${row.units.toLocaleString("en-US")} |`);
  }
  return lines.join("\n");
}

export function formatLeaderboard(data: LeaderboardResult): string {
  const lines = [`**Sales rep leaderboard — last ${data.days} days**`, "", "| Rank | Rep | Revenue | Deals |", "|---|---|---|---|"];
  for (const row of data.rows) {
    lines.push(`| ${row.rank} | ${row.rep} | ${fmtCurrency(row.revenue)} | ${row.deals.toLocaleString("en-US")} |`);
  }
  return lines.join("\n");
}
