import type { Analytics, Product, Sale } from "@/lib/db/types";

/**
 * Unified Business Intelligence core.
 * Pure function over (sales, products) so both drivers produce byte-identical reports —
 * the Supabase driver fetches rows, the local driver reads the JSON store.
 */
export function buildAnalytics(allSales: Sale[], products: Product[], days = 30): Analytics {
  const since = new Date(Date.now() - days * 86400000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const done = allSales.filter((s) => s.status === "completed");
  const today = done.filter((s) => new Date(s.created_at) >= startOfToday);
  const win = done.filter((s) => new Date(s.created_at) >= since);

  const sum = (rows: Sale[]) => rows.reduce((a, s) => a + s.total, 0);
  const units = (rows: Sale[]) => rows.reduce((a, s) => a + s.lines.reduce((x, l) => x + l.qty, 0), 0);
  const aov = (rows: Sale[]) => (rows.length ? Math.round(sum(rows) / rows.length) : 0);

  const byChannelMap = new Map<string, { revenue: number; transactions: number }>();
  for (const s of win) {
    const e = byChannelMap.get(s.channel) ?? { revenue: 0, transactions: 0 };
    e.revenue += s.total;
    e.transactions += 1;
    byChannelMap.set(s.channel, e);
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  const catMap = new Map<string, { revenue: number; units: number }>();
  const prodMap = new Map<string, { title: string; sku: string; revenue: number; units: number }>();
  for (const s of win) {
    for (const l of s.lines) {
      const cat = byId.get(l.product_id)?.category ?? "Uncategorised";
      const c = catMap.get(cat) ?? { revenue: 0, units: 0 };
      c.revenue += l.line_total;
      c.units += l.qty;
      catMap.set(cat, c);
      const pr = prodMap.get(l.product_id) ?? { title: l.title, sku: l.sku, revenue: 0, units: 0 };
      pr.revenue += l.line_total;
      pr.units += l.qty;
      prodMap.set(l.product_id, pr);
    }
  }

  const dayMap = new Map<string, { revenue: number; transactions: number }>();
  for (let d = Math.min(days, 14) - 1; d >= 0; d--) {
    dayMap.set(new Date(Date.now() - d * 86400000).toISOString().slice(0, 10), { revenue: 0, transactions: 0 });
  }
  for (const s of done) {
    const key = s.created_at.slice(0, 10);
    const e = dayMap.get(key);
    if (!e) continue;
    e.revenue += s.total;
    e.transactions += 1;
  }

  const active = products.filter((p) => p.active);
  return {
    today: { revenue: sum(today), transactions: today.length, units: units(today), aov: aov(today) },
    window: { revenue: sum(win), transactions: win.length, units: units(win), aov: aov(win) },
    byChannel: [...byChannelMap.entries()].map(([channel, v]) => ({ channel: channel as "pos" | "online", ...v })),
    byCategory: [...catMap.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.revenue - a.revenue),
    topProducts: [...prodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    daily: [...dayMap.entries()].map(([date, v]) => ({ date, ...v })),
    stockValue: {
      atCost: active.reduce((a, p) => a + p.cost_price * p.stock, 0),
      atRetail: active.reduce((a, p) => a + p.price * p.stock, 0),
    },
    lowStock: active
      .filter((p) => p.stock <= p.min_stock)
      .map((p) => ({ id: p.id, sku: p.sku, title: p.title, stock: p.stock, min_stock: p.min_stock }))
      .sort((a, b) => a.stock - b.stock),
  };
}
