"use client";
import { useMemo, useState } from "react";
import { Printer, QrCode, Search, Tag } from "lucide-react";
import { STORE } from "@/lib/config";
import { fmt } from "@/lib/money";
import type { Product } from "@/lib/db/types";

/** Barcode label printer — Code 128 hang-tags (or QR) straight from product SKUs. */
export function LabelsSheet({ initial }: { initial: Product[] }) {
  const [kind, setKind] = useState<"code128" | "qrcode">("code128");
  const [columns, setColumns] = useState(3);
  const [copies, setCopies] = useState(1);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.filter((p) => p.active).slice(0, 12).map((p) => p.id)));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initial.filter((p) => !q || `${p.title} ${p.sku} ${p.category}`.toLowerCase().includes(q));
  }, [initial, query]);

  const sheet = initial.filter((p) => selected.has(p.id)).flatMap((p) => Array.from({ length: copies }, (_, i) => ({ ...p, key: `${p.id}-${i}` })));

  return (
    <div className="space-y-3">
      <div className="no-print flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold">Barcode labels</h1>
          <p className="text-sm text-ink-600">{sheet.length} label{sheet.length === 1 ? "" : "s"} queued · Code 128 or QR from the product SKU/barcode.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="field w-52 pl-9" placeholder="Find products" aria-label="Search products for labels" />
          </div>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="field w-auto" aria-label="Barcode type">
            <option value="code128">Code 128</option>
            <option value="qrcode">QR code</option>
          </select>
          <select value={columns} onChange={(e) => setColumns(Number(e.target.value))} className="field w-auto" aria-label="Labels per row">
            {[2, 3, 4].map((c) => <option key={c} value={c}>{c} per row</option>)}
          </select>
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))} className="field w-auto" aria-label="Copies per product">
            {[1, 2, 3].map((c) => <option key={c} value={c}>×{c}</option>)}
          </select>
          <button onClick={() => setSelected(new Set(rows.map((p) => p.id)))} className="btn-ghost text-xs">Select all</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost text-xs">Clear</button>
          <button onClick={() => window.print()} disabled={!sheet.length} className="btn-primary text-xs"><Printer size={14} /> Print sheet</button>
        </div>
      </div>

      <div className="no-print card max-h-56 overflow-y-auto p-3">
        <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-clay-700/10 px-2 py-1.5 text-xs hover:bg-clay-50">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="font-mono text-[10px] text-ink-600">{p.sku}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div
        className="grid gap-2 print-area"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {sheet.map((p) => (
          <div key={p.key} className="rounded-lg border border-dashed border-clay-700/25 bg-white p-2 text-center">
            <p className="font-display text-[11px] font-bold tracking-wide">{STORE.name}</p>
            <p className="line-clamp-2 text-[11px] font-semibold">{p.title}</p>
            <p className="text-[10px] text-ink-600">Size {p.size} · {p.condition}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/barcode?value=${encodeURIComponent(kind === "code128" ? p.barcode || p.sku : p.sku)}&kind=${kind}`}
              alt={`${p.sku} barcode`}
              className="mx-auto my-1 h-14 w-full object-contain"
            />
            <p className="font-mono text-[10px] tracking-wide">{kind === "code128" ? p.barcode || p.sku : p.sku}</p>
            <p className="text-sm font-bold">{fmt(p.price)}</p>
            {p.discount_pct > 0 && <p className="text-[10px] font-semibold text-clay-600">{p.discount_pct}% off → {fmt(Math.round((p.price * (1 - p.discount_pct / 100)) / 100) * 100)}</p>}
          </div>
        ))}
        {!sheet.length && <p className="col-span-full py-10 text-center text-sm text-ink-600"><Tag size={18} className="mx-auto mb-2 opacity-40" />Select products above to build a label sheet.</p>}
      </div>

      <p className="no-print flex items-center gap-1.5 text-xs text-ink-600">
        <QrCode size={12} /> Labels render through /api/barcode (server-side bwip-js) so printed output matches the scanner table exactly.
      </p>
    </div>
  );
}
