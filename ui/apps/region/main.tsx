import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { RegionResult } from "../../../server/mockData";
import { BarChart, type BarRow } from "../../shared/BarChart";
import { CHANNEL_NAMES } from "../../shared/constants";
import { Segmented, Toggle } from "../../shared/Filters";
import { fmtCompactCurrency } from "../../shared/format";
import { safeAreaStyle } from "../../shared/safeArea";
import { useSalesApp } from "../../shared/useSalesApp";
import "../../shared/theme.css";

const METRIC_OPTIONS: { label: string; value: "revenue" | "orders" }[] = [
  { label: "Revenue", value: "revenue" },
  { label: "Orders", value: "orders" },
];

function formatOrders(n: number): string {
  return n.toLocaleString("en-US");
}

function RegionApp() {
  const { data, error, pending, hostContext, refetch } = useSalesApp<RegionResult>("get_sales_by_region");

  if (error) {
    return (
      <div className="viz-root">
        <strong>Error:</strong> {error.message}
      </div>
    );
  }
  if (!data) {
    return <div className="viz-root viz-loading">Loading regional sales…</div>;
  }

  const valueFormatter = data.metric === "revenue" ? fmtCompactCurrency : formatOrders;

  const rows: BarRow[] = data.rows.map((r) => ({
    label: r.region,
    value: r.value,
    breakdown:
      data.splitByChannel && r.byChannel
        ? CHANNEL_NAMES.map((c) => ({ key: c, value: r.byChannel?.[c] ?? 0 }))
        : undefined,
  }));

  return (
    <main className="viz-root" style={safeAreaStyle(hostContext)}>
      <div className="viz-header">
        <div>
          <div className="viz-title">Sales by Region</div>
          <div className="viz-subtitle">
            {data.metric === "revenue" ? "Revenue" : "Orders"} · last {data.days} days
          </div>
        </div>
      </div>

      <div className="viz-filters">
        <Segmented
          value={data.metric}
          options={METRIC_OPTIONS}
          disabled={pending}
          onChange={(metric) => refetch({ days: data.days, metric, splitByChannel: data.splitByChannel })}
        />
        <Toggle
          active={data.splitByChannel}
          label="Split by channel"
          disabled={pending || data.metric !== "revenue"}
          onClick={() => refetch({ days: data.days, metric: data.metric, splitByChannel: !data.splitByChannel })}
        />
      </div>

      <BarChart
        rows={rows}
        grouped={data.splitByChannel}
        seriesKeys={data.splitByChannel ? [...CHANNEL_NAMES] : undefined}
        valueFormatter={valueFormatter}
      />

      <div className="viz-footnote">Mock data · MCP Apps proof of concept</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegionApp />
  </StrictMode>,
);
