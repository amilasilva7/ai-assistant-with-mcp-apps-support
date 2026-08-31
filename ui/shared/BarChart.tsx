import { useRef, useState } from "react";
import { fmtCompactCurrency } from "./format";

export interface BarRow {
  label: string;
  value: number;
  breakdown?: { key: string; value: number }[];
  detail?: string;
}

interface Props {
  rows: BarRow[];
  seriesKeys?: string[];
  valueFormatter?: (n: number) => string;
  grouped?: boolean;
}

const W = 640;
const MARGIN = { top: 4, right: 56, bottom: 4, left: 128 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const LABEL_H = 16;
const SIMPLE_BAR_H = 18;
const SUB_BAR_H = 8;
const SUB_GAP = 3;
const ROW_GAP = 14;

const SERIES_VARS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

export function BarChart({ rows, seriesKeys, valueFormatter = fmtCompactCurrency, grouped = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const maxVal =
    Math.max(
      1,
      ...rows.flatMap((r) => (grouped && r.breakdown ? r.breakdown.map((b) => b.value) : [r.value])),
    ) * 1.08;

  const barsContentH = grouped ? seriesKeys!.length * SUB_BAR_H + (seriesKeys!.length - 1) * SUB_GAP : SIMPLE_BAR_H;
  const rowH = LABEL_H + barsContentH + ROW_GAP;
  const H = rowH * rows.length;

  const widthFor = (v: number) => (v / maxVal) * PLOT_W;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", aspectRatio: `${W} / ${H}`, display: "block", overflow: "visible" }}>
        {rows.map((row, i) => {
          const rowTop = i * rowH;
          const barsTop = rowTop + LABEL_H;
          const isHover = hover === i;

          return (
            <g key={row.label} opacity={hover === null || isHover ? 1 : 0.45} style={{ transition: "opacity 120ms" }}>
              <text x={0} y={rowTop + LABEL_H - 4} fontSize={11.5} fill="var(--text-primary)" fontWeight={isHover ? 600 : 400}>
                {row.label}
              </text>

              {grouped && row.breakdown
                ? row.breakdown.map((b, si) => {
                    const y = barsTop + si * (SUB_BAR_H + SUB_GAP);
                    const w = Math.max(2, widthFor(b.value));
                    return (
                      <rect
                        key={b.key}
                        x={MARGIN.left}
                        y={y}
                        width={w}
                        height={SUB_BAR_H}
                        rx={3}
                        fill={SERIES_VARS[si % SERIES_VARS.length]}
                      />
                    );
                  })
                : (() => {
                    const w = Math.max(3, widthFor(row.value));
                    return (
                      <>
                        <rect x={MARGIN.left} y={barsTop} width={w} height={SIMPLE_BAR_H} rx={4} fill="var(--series-1)" />
                        <text
                          x={MARGIN.left + w + 8}
                          y={barsTop + SIMPLE_BAR_H / 2}
                          dominantBaseline="middle"
                          fontSize={11.5}
                          fill="var(--text-secondary)"
                        >
                          {valueFormatter(row.value)}
                        </text>
                      </>
                    );
                  })()}

              {/* Row hover-capture surface */}
              <rect
                x={0}
                y={rowTop}
                width={W}
                height={rowH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>

      {hover !== null && grouped && rows[hover].breakdown && (
        <RowTooltip row={rows[hover]} rowIndex={hover} rowH={rowH} wrapRef={wrapRef} valueFormatter={valueFormatter} />
      )}

      {hover !== null && !grouped && rows[hover].detail && (
        <SimpleTooltip row={rows[hover]} rowIndex={hover} rowH={rowH} wrapRef={wrapRef} valueFormatter={valueFormatter} />
      )}

      {grouped && seriesKeys && (
        <div className="viz-legend">
          {seriesKeys.map((key, i) => (
            <span key={key} className="viz-legend-item">
              <span className="viz-legend-swatch" style={{ background: SERIES_VARS[i % SERIES_VARS.length] }} />
              {key}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SimpleTooltip({
  row,
  rowIndex,
  rowH,
  wrapRef,
  valueFormatter,
}: {
  row: BarRow;
  rowIndex: number;
  rowH: number;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  valueFormatter: (n: number) => string;
}) {
  const scale = (wrapRef.current?.getBoundingClientRect().width ?? W) / W;
  const top = (rowIndex * rowH + LABEL_H + 4) * scale;

  return (
    <div className="viz-tooltip" style={{ left: MARGIN.left * scale + 40, top, transform: "translate(0, -8px)" }}>
      <div>{row.label}</div>
      <div>
        <strong>{valueFormatter(row.value)}</strong>
      </div>
      <div>{row.detail}</div>
    </div>
  );
}

function RowTooltip({
  row,
  rowIndex,
  rowH,
  wrapRef,
  valueFormatter,
}: {
  row: BarRow;
  rowIndex: number;
  rowH: number;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  valueFormatter: (n: number) => string;
}) {
  const scale = (wrapRef.current?.getBoundingClientRect().width ?? W) / W;
  const top = (rowIndex * rowH + LABEL_H + 4) * scale;

  return (
    <div className="viz-tooltip" style={{ left: MARGIN.left * scale + 40, top, transform: "translate(0, -8px)" }}>
      <div>{row.label}</div>
      {row.breakdown!.map((b) => (
        <div key={b.key}>
          {b.key}: <strong>{valueFormatter(b.value)}</strong>
        </div>
      ))}
    </div>
  );
}
