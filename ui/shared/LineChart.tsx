import { useMemo, useRef, useState } from "react";
import { fmtCompactCurrency, fmtCurrency, fmtDate } from "./format";

export interface LinePoint {
  date: string;
  revenue: number;
}

interface Props {
  points: LinePoint[];
}

const W = 700;
const H = 220;
const MARGIN = { top: 14, right: 10, bottom: 24, left: 52 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const PLOT_H = H - MARGIN.top - MARGIN.bottom;

export function LineChart({ points }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const maxVal = useMemo(() => Math.max(1, ...points.map((p) => p.revenue)) * 1.12, [points]);
  const n = points.length;

  const xAt = (i: number) => MARGIN.left + (n <= 1 ? 0 : (i / (n - 1)) * PLOT_W);
  const yAt = (v: number) => MARGIN.top + PLOT_H - (v / maxVal) * PLOT_H;

  const linePath = useMemo(
    () => points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.revenue).toFixed(1)}`).join(" "),
    [points, maxVal],
  );
  const areaPath = useMemo(() => {
    if (n === 0) return "";
    return `${linePath} L${xAt(n - 1).toFixed(1)},${MARGIN.top + PLOT_H} L${xAt(0).toFixed(1)},${MARGIN.top + PLOT_H} Z`;
  }, [linePath, n]);

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (maxVal / yTicks) * i;
    return { v, y: yAt(v) };
  });

  // Sparse date ticks so labels don't collide.
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const dateTicks = points.map((p, i) => ({ ...p, i })).filter((p) => p.i % tickEvery === 0 || p.i === n - 1);

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const vbX = relX * W;
    const idx = Math.round(((vbX - MARGIN.left) / PLOT_W) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, idx)));
  }

  const hoverPoint = hover !== null ? points[hover] : null;
  const scale = (wrapRef.current?.getBoundingClientRect().width ?? W) / W;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", aspectRatio: `${W} / ${H}`, display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={MARGIN.left} x2={W - MARGIN.right} y1={g.y} y2={g.y} stroke="var(--gridline)" strokeWidth={1} />
            <text x={MARGIN.left - 8} y={g.y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-muted)">
              {fmtCompactCurrency(g.v)}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left}
          y1={MARGIN.top}
          y2={MARGIN.top + PLOT_H}
          stroke="var(--baseline)"
          strokeWidth={1}
        />

        {dateTicks.map((t) => (
          <text key={t.i} x={xAt(t.i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {fmtDate(t.date)}
          </text>
        ))}

        <path d={areaPath} fill="url(#lineFill)" />
        <path d={linePath} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {n > 0 && (
          <circle cx={xAt(n - 1)} cy={yAt(points[n - 1].revenue)} r={3.5} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={1.5} />
        )}

        {hover !== null && (
          <>
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={MARGIN.top}
              y2={MARGIN.top + PLOT_H}
              stroke="var(--baseline)"
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            <circle cx={xAt(hover)} cy={yAt(hoverPoint!.revenue)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
          </>
        )}

        {/* Hover capture surface, on top */}
        <rect
          x={MARGIN.left}
          y={0}
          width={PLOT_W}
          height={H}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hoverPoint && (
        <div
          className="viz-tooltip"
          style={{
            left: xAt(hover!) * scale,
            top: yAt(hoverPoint.revenue) * scale - 8,
          }}
        >
          <div>{fmtDate(hoverPoint.date)}</div>
          <strong>{fmtCurrency(hoverPoint.revenue)}</strong>
        </div>
      )}
    </div>
  );
}
