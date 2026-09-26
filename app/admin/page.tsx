import Link from "next/link";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Wallet } from "lucide-react";
import { db } from "@/lib/db";
import { fmt, fmtNumber } from "@/lib/money";
import { computeMargin } from "@/lib/margin";
import { Badge, Stat } from "@/components/ui";
import { CategoryBars, ChannelSplit, DailyBars, TenderMix, TopProducts } from "@/components/admin/Charts";

export const dynamic = "force-dynamic";

/** Unified Business Intelligence Dashboard — both channels in one view. */
export default async function AdminDashboard({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const days = Math.min(Math.max(Number((await searchParams).days ?? 30) || 30, 1), 365);
  const [a, products, sales] = await Promise.all([db().analytics(days), db().listProducts({ includeInactive: true }), db().listSales({ limit: 5000 })]);

  const margin = computeMargin(a.stockValue.atCost, a.stockValue.atRetail);
  const soldCost = sales.filter((s) => s.status === "completed").reduce((acc, s) => {
    return acc + s.lines.reduce((x, l) => {
      const p = products.find((q) => q.id === l.product_id);
      return x + (p?.cost_price ?? 0) * l.qty;
    }, 0);
  }, 0);
  const realisedRevenue = sales.filter((s) => s.status === "completed").reduce((acc, s) => acc + s.total, 0);
  const realisedMargin = computeMargin(soldCost, realisedRevenue);
  const pending = sales.filter((s) => s.status === "pending");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold">Business performance</h1>
          <p className="text-sm text-ink-600">Counter and online channels combined, in UGX.</p>
        </div>
        <form className="flex items-center gap-2">
          <label className="text-xs font-semibold text-ink-600" htmlFor="days">Window</label>
          <select id="days" name="days" defaultValue={String(days)} className="field w-auto py-1.5">
            {[7, 14, 30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <button className="btn-ghost py-1.5" type="submit">Apply</button>
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Today's gross revenue" value={fmt(a.today.revenue)} sub={`${a.today.transactions} transactions · ${a.today.units} units`} tone="brass" />
        <Stat label={`Revenue · ${days}d`} value={fmt(a.window.revenue)} sub={`${a.window.transactions} transactions`} />
        <Stat label="Average order value" value={fmt(a.window.aov)} sub={`today ${fmt(a.today.aov)}`} />
        <Stat label="Realised margin" value={`${realisedMargin.marginPct}%`} sub={`gross profit ${fmt(realisedMargin.grossProfit)}`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <DailyBars daily={a.daily} />
        <div className="space-y-3">
          <ChannelSplit rows={a.byChannel} />
          <TenderMix rows={a.byTender} />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <CategoryBars rows={a.byCategory} />
        <TopProducts rows={a.topProducts} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 font-display text-base font-bold">Inventory valuation</h3>
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between"><span className="text-ink-600">Stock at cost</span><span className="tabular-nums">{fmt(a.stockValue.atCost)}</span></li>
            <li className="flex justify-between"><span className="text-ink-600">Stock at retail</span><span className="tabular-nums">{fmt(a.stockValue.atRetail)}</span></li>
            <li className="flex justify-between font-semibold"><span>Potential gross profit</span><span className="tabular-nums">{fmt(margin.grossProfit)} ({margin.marginPct}%)</span></li>
            <li className="flex justify-between"><span className="text-ink-600">Active SKUs</span><span className="tabular-nums">{products.filter((p) => p.active).length}</span></li>
            <li className="flex justify-between"><span className="text-ink-600">Units on the floor</span><span className="tabular-nums">{products.reduce((s, p) => s + p.stock, 0)}</span></li>
          </ul>
        </div>

        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-base font-bold">Low stock & reorders</h3>
            <Badge tone={a.lowStock.length ? "warn" : "good"}>{a.lowStock.length} flagged</Badge>
          </div>
          {a.lowStock.length === 0 ? (
            <p className="text-sm text-ink-600">Every item is above its reorder point.</p>
          ) : (
            <ul className="max-h-56 space-y-1.5 overflow-y-auto text-sm">
              {a.lowStock.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 rounded-lg border border-clay-700/10 px-2.5 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <AlertTriangle size={14} className={l.stock === 0 ? "text-clay-600" : "text-brass-600"} />
                    <span className="truncate">{l.title}</span>
                    <span className="font-mono text-[10px] text-ink-600">{l.sku}</span>
                  </span>
                  <span className="shrink-0 text-xs font-bold">{l.stock === 0 ? "SOLD OUT" : `${l.stock} left`}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/admin/inventory" className="btn-ghost mt-3 w-full py-2 text-xs">Open inventory grid</Link>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card border-brass-500/40 bg-brass-500/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              <ArrowDownRight size={15} className="mr-1 inline" />
              {pending.length} online order{pending.length === 1 ? "" : "s"} waiting for approval ({fmt(pending.reduce((s, p) => s + p.total, 0))}). Stock only moves once you approve.
            </p>
            <Link href="/admin/sales?status=pending" className="btn-primary py-2 text-xs">Review orders</Link>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-600">
        <Wallet size={13} /> Margin maths: {fmtNumber(realisedRevenue - soldCost)} gross profit on {fmtNumber(realisedRevenue)} of completed sales across both channels.
        <ArrowUpRight size={13} />
      </p>
    </div>
  );
}
