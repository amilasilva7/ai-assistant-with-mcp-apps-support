import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { TrendResult } from "../../../server/mockData";
import { Segmented } from "../../shared/Filters";
import { LineChart } from "../../shared/LineChart";
import { REGION_NAMES } from "../../shared/constants";
import { fmtCurrency, fmtPct } from "../../shared/format";
import { safeAreaStyle } from "../../shared/safeArea";
import { useSalesApp } from "../../shared/useSalesApp";
import "../../shared/theme.css";

const DAY_OPTIONS = [
  { label: "7D", value: 7 },
  { label: "30D", value: 30 },
  { label: "90D", value: 90 },
];
const REGION_OPTIONS: { label: string; value: string }[] = [
  { label: "All regions", value: "all" },
  ...REGION_NAMES.map((r) => ({ label: r, value: r })),
];

function TrendApp() {
  const { data, error, pending, hostContext, refetch } = useSalesApp<TrendResult>("get_daily_sales_trend");

  if (error) {
    return (
      <div className="viz-root">
        <strong>Error:</strong> {error.message}
      </div>
    );
  }
  if (!data) {
    return <div className="viz-root viz-loading">Loading sales trend…</div>;
  }

  const region = data.region ?? "all";
  const deltaClass = data.pctChangeVsPrior !== null && data.pctChangeVsPrior >= 0 ? "viz-delta-up" : "viz-delta-down";

  return (
    <main className="viz-root" style={safeAreaStyle(hostContext)}>
      <div className="viz-header">
        <div>
          <div className="viz-title">Daily Sales Trend</div>
          <div className="viz-subtitle">
            {region === "all" ? "All regions" : region} · last {data.days} days
          </div>
        </div>
        <div className="viz-stat">
          <strong>{fmtCurrency(data.totalRevenue)}</strong> total
          {data.pctChangeVsPrior !== null && (
            <>
              {" · "}
              <span className={deltaClass}>{fmtPct(data.pctChangeVsPrior)}</span> vs. prior period
            </>
          )}
        </div>
      </div>

      <div className="viz-filters">
        <Segmented
          value={data.days}
          options={DAY_OPTIONS}
          disabled={pending}
          onChange={(days) => refetch({ days, region: region === "all" ? undefined : region })}
        />
        <Segmented
          value={region}
          options={REGION_OPTIONS}
          disabled={pending}
          onChange={(r) => refetch({ days: data.days, region: r === "all" ? undefined : r })}
        />
      </div>

      <LineChart points={data.points} />

      <div className="viz-footnote">Mock data · MCP Apps proof of concept</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TrendApp />
  </StrictMode>,
);
