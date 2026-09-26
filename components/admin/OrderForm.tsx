"use client";
import { useMemo, useState } from "react";
import { Minus, Plus, Save, Search, X } from "lucide-react";
import { unitPrice } from "@/lib/money";
import { Money } from "@/components/ui";
import type { Product, Sale } from "@/lib/db/types";

type Line = { product_id: string; sku: string; title: string; qty: number; unit_price: number };

/**
 * Back-office order entry — logs an order taken by phone or WhatsApp into the
 * ledger as `pending`. Stock only moves when a manager approves it, which is the
 * same code path the public showroom's reserve action uses.
 */
export function OrderForm({
  products,
  onClose,
  onCreated,
}: {
  products: Product[];
  onClose: () => void;
  onCreated: (sale: Sale) => void;
}) {
  const [customer, setCustomer] = useState({ name: "", phone: "", note: "" });
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.active && `${p.title} ${p.sku} ${p.size}`.toLowerCase().includes(q)).slice(0, 6);
  }, [products, query]);

  const total = lines.reduce((sum, l) => sum + l.unit_price * l.qty, 0);

  const add = (p: Product) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.product_id === p.id);
      if (existing) return prev.map((l) => (l.product_id === p.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { product_id: p.id, sku: p.sku, title: p.title, qty: 1, unit_price: unitPrice(p.price, p.discount_pct) }];
    });
    setQuery("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/sales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "online",
        status: "pending",
        customer_name: customer.name,
        customer_phone: customer.phone,
        note: customer.note,
        lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price })),
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json.ok) return setError(json.error ?? "Could not save the order.");
    onCreated(json.data as Sale);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/50 p-3">
      <form onSubmit={submit} className="card my-6 w-full max-w-xl space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold">Log an order</h2>
            <p className="text-xs text-ink-600">Saved as pending — stock moves when you approve it.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-ink-900/5" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="of-name">Customer name</label>
            <input id="of-name" required minLength={2} className="field" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="of-phone">Phone</label>
            <input id="of-phone" required pattern="\+?[0-9]{9,15}" placeholder="+2567XXXXXXXX" className="field" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="of-note">Note</label>
            <input id="of-note" className="field" placeholder="Delivery to Ntinda, pay on collection…" value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} />
          </div>
        </div>

        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="field pl-9" placeholder="Search the rail to add items…" aria-label="Search products" />
          {results.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-ink-900/15 bg-white shadow-lg">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => add(p)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-sand-50">
                    <span className="min-w-0 truncate">{p.title} <span className="font-mono text-[10px] text-ink-600">{p.sku}</span></span>
                    <span className="shrink-0 tabular-nums"><Money value={unitPrice(p.price, p.discount_pct)} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lines.length > 0 ? (
          <ul className="space-y-1.5">
            {lines.map((l) => (
              <li key={l.product_id} className="flex items-center gap-2 rounded-lg border border-ink-900/10 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">{l.title} <span className="font-mono text-[10px] text-ink-600">{l.sku}</span></span>
                <button type="button" onClick={() => setLines((prev) => prev.map((x) => (x.product_id === l.product_id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} className="grid h-6 w-6 place-items-center rounded-md border border-ink-900/15" aria-label="Decrease"><Minus size={12} /></button>
                <span className="w-6 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                <button type="button" onClick={() => setLines((prev) => prev.map((x) => (x.product_id === l.product_id ? { ...x, qty: x.qty + 1 } : x)))} className="grid h-6 w-6 place-items-center rounded-md border border-ink-900/15" aria-label="Increase"><Plus size={12} /></button>
                <span className="w-24 text-right text-sm tabular-nums"><Money value={l.unit_price * l.qty} /></span>
                <button type="button" onClick={() => setLines((prev) => prev.filter((x) => x.product_id !== l.product_id))} className="rounded-md p-1 text-clay-500 hover:bg-clay-50" aria-label="Remove line"><X size={13} /></button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-ink-900/5 px-3 py-4 text-center text-sm text-ink-600">No items yet — search above.</p>
        )}

        <div className="flex items-center justify-between border-t border-ink-900/10 pt-2 text-sm">
          <span className="text-ink-600">Order total</span>
          <span className="text-lg font-bold tabular-nums"><Money value={total} /></span>
        </div>

        {error && <p className="rounded-lg bg-clay-50 px-3 py-2 text-sm font-semibold text-clay-600">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button disabled={busy || !lines.length} className="btn-primary flex-1"><Save size={15} /> {busy ? "Saving…" : "Save as pending"}</button>
        </div>
      </form>
    </div>
  );
}
