/**
 * All-mock sales data for the POC. Deterministically seeded so every run
 * (and every host in the demo) shows the same numbers.
 */

const HISTORY_DAYS = 200;
const SEED = 88172645;

function mulberry32(seed: number) {
  let t = seed;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Centered noise multiplier, e.g. noise(0.1) => roughly [0.9, 1.1]
function noise(rand: () => number, spread: number): number {
  return 1 + (rand() - 0.5) * spread;
}

export interface Region {
  name: string;
  weight: number;
}
export interface Channel {
  name: string;
  weight: number;
}
export interface Product {
  name: string;
  weight: number;
  avgPrice: number;
}
export interface Rep {
  name: string;
  weight: number;
}

export const REGIONS: Region[] = [
  { name: "North America", weight: 0.42 },
  { name: "EMEA", weight: 0.27 },
  { name: "APAC", weight: 0.2 },
  { name: "LATAM", weight: 0.11 },
];

export const CHANNELS: Channel[] = [
  { name: "Online", weight: 0.55 },
  { name: "Retail", weight: 0.3 },
  { name: "Wholesale", weight: 0.15 },
];

export const PRODUCTS: Product[] = [
  { name: "Aurora Suite", weight: 0.28, avgPrice: 220 },
  { name: "Nimbus Analytics", weight: 0.22, avgPrice: 180 },
  { name: "Vantage CRM", weight: 0.18, avgPrice: 150 },
  { name: "Pulse Automation", weight: 0.14, avgPrice: 95 },
  { name: "Beacon Support", weight: 0.11, avgPrice: 60 },
  { name: "Forge Integrations", weight: 0.07, avgPrice: 340 },
];

export const REPS: Rep[] = [
  { name: "Priya Chandran", weight: 0.22 },
  { name: "Marcus Webb", weight: 0.19 },
  { name: "Elena Torres", weight: 0.17 },
  { name: "Jamal Carter", weight: 0.15 },
  { name: "Sofia Rinaldi", weight: 0.14 },
  { name: "Ben Okafor", weight: 0.13 },
];

interface DayRecord {
  date: string; // YYYY-MM-DD
  totalRevenue: number;
  totalOrders: number;
  byRegion: Record<string, { revenue: number; orders: number; byChannel: Record<string, number> }>;
  byProduct: Record<string, { revenue: number; units: number }>;
  byRep: Record<string, { revenue: number; deals: number }>;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildHistory(): DayRecord[] {
  const rand = mulberry32(SEED);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const days: DayRecord[] = [];

  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - i);
    const dayOfWeek = date.getUTCDay(); // 0 = Sun
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Slow upward trend across the window + weekly seasonality + noise.
    const progress = (HISTORY_DAYS - 1 - i) / (HISTORY_DAYS - 1);
    const base = 38000 + progress * 15000;
    const seasonality = isWeekend ? 0.62 : 1.05;
    const totalRevenue = Math.round(base * seasonality * noise(rand, 0.14));
    const avgOrderValue = 165 * noise(rand, 0.08);
    const totalOrders = Math.round(totalRevenue / avgOrderValue);

    const byRegion: DayRecord["byRegion"] = {};
    for (const region of REGIONS) {
      const regionRevenue = Math.round(totalRevenue * region.weight * noise(rand, 0.1));
      const regionOrders = Math.round(totalOrders * region.weight * noise(rand, 0.1));
      const byChannel: Record<string, number> = {};
      for (const channel of CHANNELS) {
        byChannel[channel.name] = Math.round(regionRevenue * channel.weight * noise(rand, 0.15));
      }
      byRegion[region.name] = { revenue: regionRevenue, orders: regionOrders, byChannel };
    }

    const byProduct: DayRecord["byProduct"] = {};
    for (const product of PRODUCTS) {
      const revenue = Math.round(totalRevenue * product.weight * noise(rand, 0.2));
      const units = Math.max(1, Math.round(revenue / (product.avgPrice * noise(rand, 0.06))));
      byProduct[product.name] = { revenue, units };
    }

    const byRep: DayRecord["byRep"] = {};
    for (const rep of REPS) {
      const revenue = Math.round(totalRevenue * rep.weight * noise(rand, 0.22));
      const deals = Math.max(0, Math.round(revenue / (480 * noise(rand, 0.1))));
      byRep[rep.name] = { revenue, deals };
    }

    days.push({ date: isoDate(date), totalRevenue, totalOrders, byRegion, byProduct, byRep });
  }

  return days;
}

// Computed once per process start; every query slices this fixed dataset.
const HISTORY = buildHistory();

function lastNDays(days: number): DayRecord[] {
  return HISTORY.slice(Math.max(0, HISTORY.length - days));
}

function priorNDays(days: number): DayRecord[] {
  const end = Math.max(0, HISTORY.length - days);
  return HISTORY.slice(Math.max(0, end - days), end);
}

export interface TrendPoint {
  date: string;
  revenue: number;
}

export interface TrendResult {
  days: number;
  region: string | null;
  points: TrendPoint[];
  totalRevenue: number;
  avgDailyRevenue: number;
  pctChangeVsPrior: number | null;
}

export function getDailyTrend(days: number, region?: string | null): TrendResult {
  const window = lastNDays(days);
  const prior = priorNDays(days);

  const revenueFor = (rec: DayRecord) => (region ? rec.byRegion[region]?.revenue ?? 0 : rec.totalRevenue);

  const points = window.map((rec) => ({ date: rec.date, revenue: revenueFor(rec) }));
  const totalRevenue = points.reduce((sum, p) => sum + p.revenue, 0);
  const avgDailyRevenue = Math.round(totalRevenue / Math.max(1, points.length));

  let pctChangeVsPrior: number | null = null;
  if (prior.length === window.length && prior.length > 0) {
    const priorTotal = prior.reduce((sum, rec) => sum + revenueFor(rec), 0);
    if (priorTotal > 0) {
      pctChangeVsPrior = ((totalRevenue - priorTotal) / priorTotal) * 100;
    }
  }

  return { days, region: region ?? null, points, totalRevenue, avgDailyRevenue, pctChangeVsPrior };
}

export interface RegionRow {
  region: string;
  value: number;
  byChannel?: Record<string, number>;
}

export interface RegionResult {
  days: number;
  metric: "revenue" | "orders";
  splitByChannel: boolean;
  channels: string[];
  rows: RegionRow[];
}

export function getSalesByRegion(
  days: number,
  metric: "revenue" | "orders" = "revenue",
  splitByChannel = false,
): RegionResult {
  const window = lastNDays(days);

  const rows: RegionRow[] = REGIONS.map((region) => {
    let value = 0;
    const byChannel: Record<string, number> = {};
    for (const channel of CHANNELS) byChannel[channel.name] = 0;

    for (const rec of window) {
      const r = rec.byRegion[region.name];
      if (!r) continue;
      value += metric === "revenue" ? r.revenue : r.orders;
      if (metric === "revenue") {
        for (const channel of CHANNELS) {
          byChannel[channel.name] += r.byChannel[channel.name] ?? 0;
        }
      }
    }

    return {
      region: region.name,
      value: Math.round(value),
      byChannel: splitByChannel && metric === "revenue" ? byChannel : undefined,
    };
  }).sort((a, b) => b.value - a.value);

  return {
    days,
    metric,
    splitByChannel: splitByChannel && metric === "revenue",
    channels: CHANNELS.map((c) => c.name),
    rows,
  };
}

export interface ProductRow {
  rank: number;
  product: string;
  revenue: number;
  units: number;
}

export interface ProductResult {
  days: number;
  topN: number;
  rows: ProductRow[];
}

export function getTopProducts(days: number, topN: number): ProductResult {
  const window = lastNDays(days);
  const totals = new Map<string, { revenue: number; units: number }>();
  for (const product of PRODUCTS) totals.set(product.name, { revenue: 0, units: 0 });

  for (const rec of window) {
    for (const product of PRODUCTS) {
      const p = rec.byProduct[product.name];
      if (!p) continue;
      const agg = totals.get(product.name)!;
      agg.revenue += p.revenue;
      agg.units += p.units;
    }
  }

  const rows = [...totals.entries()]
    .map(([product, v]) => ({ product, revenue: Math.round(v.revenue), units: v.units }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topN)
    .map((row, i) => ({ rank: i + 1, ...row }));

  return { days, topN, rows };
}

export interface LeaderboardRow {
  rank: number;
  rep: string;
  revenue: number;
  deals: number;
}

export interface LeaderboardResult {
  days: number;
  topN: number;
  rows: LeaderboardRow[];
}

export function getSalesLeaderboard(days: number, topN: number): LeaderboardResult {
  const window = lastNDays(days);
  const totals = new Map<string, { revenue: number; deals: number }>();
  for (const rep of REPS) totals.set(rep.name, { revenue: 0, deals: 0 });

  for (const rec of window) {
    for (const rep of REPS) {
      const r = rec.byRep[rep.name];
      if (!r) continue;
      const agg = totals.get(rep.name)!;
      agg.revenue += r.revenue;
      agg.deals += r.deals;
    }
  }

  const rows = [...totals.entries()]
    .map(([rep, v]) => ({ rep, revenue: Math.round(v.revenue), deals: v.deals }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topN)
    .map((row, i) => ({ rank: i + 1, ...row }));

  return { days, topN, rows };
}
