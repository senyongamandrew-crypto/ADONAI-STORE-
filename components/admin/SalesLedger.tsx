"use client";
import { useMemo, useState } from "react";
import { CheckCircle2, Eye, Plus, Receipt as ReceiptIcon, Undo2, XCircle } from "lucide-react";
import { fmt, fmtNumber } from "@/lib/money";
import { Badge } from "@/components/ui";
import { Receipt } from "@/components/Receipt";
import { OrderForm } from "@/components/admin/OrderForm";
import type { Product, Sale, SaleStatus } from "@/lib/db/types";

const statusTone = (s: SaleStatus) => (s === "completed" ? "good" : s === "pending" ? "warn" : "bad");

/** Sales & orders ledger: review, approve (decrements stock), cancel/refund (restocks). */
export function SalesLedger({ initial, initialStatus, products }: { initial: Sale[]; initialStatus: string; products: Product[] }) {
  const [sales, setSales] = useState<Sale[]>(initial);
  const [showForm, setShowForm] = useState(false);
  const [status, setStatus] = useState(initialStatus || "all");
  const [channel, setChannel] = useState("all");
  const [open, setOpen] = useState<Sale | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const move = async (sale: Sale, next: SaleStatus) => {
    const res = await fetch(`/api/sales/${sale.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const json = await res.json();
    if (!json.ok) return setNotice(json.error ?? "Update failed.");
    const updated = json.data as Sale;
    setSales((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setNotice(
      next === "completed"
        ? `${updated.ref} approved — stock decremented.`
        : `${updated.ref} ${next} — stock returned to the rail.`,
    );
    setTimeout(() => setNotice(null), 3500);
  };

  const rows = useMemo(
    () =>
      sales
        .filter((s) => status === "all" || s.status === status)
        .filter((s) => channel === "all" || s.channel === channel)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [sales, status, channel],
  );

  const totals = rows.reduce((acc, s) => ({ revenue: acc.revenue + (s.status === "completed" ? s.total : 0), pending: acc.pending + (s.status === "pending" ? s.total : 0) }), { revenue: 0, pending: 0 });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold">Sales & orders</h1>
          <p className="text-sm text-ink-600">
            {rows.length} records · {fmt(totals.revenue)} completed{totals.pending ? ` · ${fmt(totals.pending)} awaiting approval` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="field w-auto" aria-label="Filter channel">
            <option value="all">Both channels</option>
            <option value="pos">In-store</option>
            <option value="online">Online</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="field w-auto" aria-label="Filter status">
            <option value="all">All statuses</option>
            <option value="completed">Completed</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
          </select>
          <button onClick={() => setShowForm(true)} className="btn-primary"><Plus size={15} /> Log order</button>
        </div>
      </div>

      {notice && <p className="rounded-xl border border-olive-600/30 bg-olive-50 px-3 py-2 text-sm font-semibold text-olive-700">{notice}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[54rem]">
          <thead className="border-b border-clay-700/10 bg-sand-50">
            <tr>
              <th className="th">Ref</th>
              <th className="th">When</th>
              <th className="th">Channel</th>
              <th className="th">Items</th>
              <th className="th text-right">Total</th>
              <th className="th">Tender</th>
              <th className="th">Status</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b border-clay-700/5 last:border-0 hover:bg-sand-50/60">
                <td className="td font-mono text-xs font-bold">{s.ref}</td>
                <td className="td text-ink-600">{new Date(s.created_at).toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "short", timeStyle: "short" })}</td>
                <td className="td">{s.channel === "pos" ? "Counter" : "Online"}</td>
                <td className="td text-ink-600">
                  {s.lines.reduce((a, l) => a + l.qty, 0)} units
                  <span className="block text-[10px]">{s.lines.map((l) => l.sku).join(", ")}</span>
                </td>
                <td className="td text-right font-semibold tabular-nums">{fmtNumber(s.total)}</td>
                <td className="td text-ink-600">
                  {s.tender ?? "—"}
                  {s.change_due > 0 && <span className="block text-[10px]">change {fmtNumber(s.change_due)}</span>}
                </td>
                <td className="td"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                <td className="td">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => setOpen(s)} className="rounded-lg border border-clay-700/15 p-1.5 hover:bg-clay-50" aria-label={`Open receipt ${s.ref}`}><Eye size={14} /></button>
                    {s.status === "pending" && (
                      <button onClick={() => move(s, "completed")} className="btn-brass px-2 py-1.5 text-xs" title="Approve and decrement stock"><CheckCircle2 size={13} /> Approve</button>
                    )}
                    {s.status === "completed" && (
                      <button onClick={() => move(s, "refunded")} className="rounded-lg border border-clay-500/30 p-1.5 text-clay-500 hover:bg-clay-50" title="Refund and restock"><Undo2 size={14} /></button>
                    )}
                    {s.status === "pending" && (
                      <button onClick={() => move(s, "cancelled")} className="rounded-lg border border-clay-700/15 p-1.5 hover:bg-clay-50" title="Cancel order"><XCircle size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td className="td text-center text-ink-600" colSpan={8}>No sales match this filter.</td></tr>}
          </tbody>
        </table>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-ink-600">
        <ReceiptIcon size={12} /> Approving an online order runs the same atomic stock decrement as a counter sale; refunds put the units back on the rail.
      </p>

      {open && <Receipt sale={open} onClose={() => setOpen(null)} />}

      {showForm && (
        <OrderForm
          products={products}
          onClose={() => setShowForm(false)}
          onCreated={(sale) => {
            setSales((prev) => [sale, ...prev]);
            setShowForm(false);
            setNotice(`${sale.ref} logged as pending — approve it to decrement stock.`);
            setTimeout(() => setNotice(null), 4000);
          }}
        />
      )}
    </div>
  );
}
