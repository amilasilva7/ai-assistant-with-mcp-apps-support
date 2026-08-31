import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ProductResult } from "../../../server/mockData";
import { BarChart, type BarRow } from "../../shared/BarChart";
import { Segmented } from "../../shared/Filters";
import { safeAreaStyle } from "../../shared/safeArea";
import { useSalesApp } from "../../shared/useSalesApp";
import "../../shared/theme.css";

const TOPN_OPTIONS = [
  { label: "Top 5", value: 5 },
  { label: "Top 10", value: 10 },
];

function ProductsApp() {
  const { data, error, pending, hostContext, refetch } = useSalesApp<ProductResult>("get_top_products");

  if (error) {
    return (
      <div className="viz-root">
        <strong>Error:</strong> {error.message}
      </div>
    );
  }
  if (!data) {
    return <div className="viz-root viz-loading">Loading top products…</div>;
  }

  const rows: BarRow[] = data.rows.map((r) => ({
    label: `${r.rank}. ${r.product}`,
    value: r.revenue,
    detail: `${r.units.toLocaleString("en-US")} units sold`,
  }));

  return (
    <main className="viz-root" style={safeAreaStyle(hostContext)}>
      <div className="viz-header">
        <div>
          <div className="viz-title">Top Products</div>
          <div className="viz-subtitle">By revenue · last {data.days} days</div>
        </div>
      </div>

      <div className="viz-filters">
        <Segmented value={data.topN} options={TOPN_OPTIONS} disabled={pending} onChange={(topN) => refetch({ days: data.days, topN })} />
      </div>

      <BarChart rows={rows} />

      <div className="viz-footnote">Mock data · MCP Apps proof of concept</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProductsApp />
  </StrictMode>,
);
