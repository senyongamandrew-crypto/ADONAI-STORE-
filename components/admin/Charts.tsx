"use client";
import { fmtNumber } from "@/lib/money";
import type { Analytics } from "@/lib/db/types";

/** Daily gross revenue + transaction volume (pure SVG, no chart dependency). */
export function DailyBars({ daily }: { daily: Analytics["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.revenue));
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-end justify-between">
        <h3 className="font-display text-base font-bold">Daily gross revenue</h3>
        <span className="text-xs text-ink-600">last {daily.length} days · UGX</span>
      </div>
      <div className="flex h-40 items-end gap-1.5">
        {daily.map((d) => (
          <div key={d.date} className="group relative flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-t-md bg-brass-500/85 transition group-hover:bg-brass-600"
              style={{ height: `${Math.max(2, (d.revenue / max) * 128)}px` }}
              title={`${d.date}: UGX ${fmtNumber(d.revenue)} · ${d.transactions} tx`}
            />
            <span className="text-[9px] text-ink-600">{d.date.slice(8)}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-center text-[11px] text-ink-600">Hover a bar for the day total and transaction count.</p>
    </div>
  );
}

export function ChannelSplit({ rows }: { rows: Analytics["byChannel"] }) {
  const total = rows.reduce((a, r) => a + r.revenue, 0) || 1;
  const tone = (c: string) => (c === "pos" ? "bg-ink-900" : "bg-brass-500");
  return (
    <div className="card p-4">
      <h3 className="mb-3 font-display text-base font-bold">Revenue by channel</h3>
      <div className="flex h-4 w-full overflow-hidden rounded-full">
        {rows.map((r) => (
          <div key={r.channel} className={tone(r.channel)} style={{ width: `${(r.revenue / total) * 100}%` }} title={`${r.channel}: UGX ${fmtNumber(r.revenue)}`} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.channel} className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${tone(r.channel)}`} />
              {r.channel === "pos" ? "In-store counter" : "Online (WhatsApp)"}
            </span>
            <span className="tabular-nums">
              <strong>{Math.round((r.revenue / total) * 100)}%</strong> · {fmtNumber(r.revenue)} · {r.transactions} tx
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CategoryBars({ rows }: { rows: Analytics["byCategory"] }) {
  const top = rows.slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.revenue));
  return (
    <div className="card p-4">
      <h3 className="mb-3 font-display text-base font-bold">Top categories</h3>
      <ul className="space-y-2">
        {top.map((r) => (
          <li key={r.category}>
            <div className="flex justify-between text-xs font-semibold">
              <span>{r.category}</span>
              <span className="tabular-nums text-ink-600">{fmtNumber(r.revenue)} · {r.units} sold</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-ink-900/10">
              <div className="h-2 rounded-full bg-clay-500" style={{ width: `${(r.revenue / max) * 100}%` }} />
            </div>
          </li>
        ))}
        {!top.length && <li className="text-sm text-ink-600">No completed sales in this window yet.</li>}
      </ul>
    </div>
  );
}

export function TopProducts({ rows }: { rows: Analytics["topProducts"] }) {
  return (
    <div className="card p-4">
      <h3 className="mb-3 font-display text-base font-bold">Best sellers</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-900/10 text-[11px] uppercase tracking-wide text-ink-600">
            <th className="th px-0">Item</th>
            <th className="th text-right">Units</th>
            <th className="th text-right">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku} className="border-b border-ink-900/5 last:border-0">
              <td className="td px-0">
                {r.title}
                <span className="block font-mono text-[10px] text-ink-600">{r.sku}</span>
              </td>
              <td className="td text-right tabular-nums">{r.units}</td>
              <td className="td text-right tabular-nums">{fmtNumber(r.revenue)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td className="td px-0 text-ink-600">Nothing sold in this window yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
