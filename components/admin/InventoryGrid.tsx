"use client";
import { useMemo, useState } from "react";
import { AlertTriangle, Minus, Pencil, Plus, Save, Search, Trash2, X } from "lucide-react";
import { CATEGORIES, CONDITIONS, SIZES } from "@/lib/config";
import { computeMargin, priceForTargetMargin } from "@/lib/margin";
import { fmt, fmtNumber } from "@/lib/money";
import { placeholderImage } from "@/lib/photo";
import { Badge } from "@/components/ui";
import type { Product } from "@/lib/db/types";

type Draft = Partial<Record<keyof Product, string | number | boolean>>;

const num = (v: string) => Math.max(0, Math.trunc(Number(v) || 0));

/** Inventory Management Data Grid — inline pricing/stock edits plus a full editor modal. */
export function InventoryGrid({ initial }: { initial: Product[] }) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const flash = (tone: "ok" | "error", text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 3200);
  };

  const draft = (p: Product): Draft => drafts[p.id] ?? {};
  const setField = (id: string, key: keyof Product, value: string) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: value } }));

  const save = async (p: Product) => {
    const d = draft(p);
    if (!Object.keys(d).length) return;
    setBusy(p.id);
    const res = await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...d,
        price: d.price != null ? num(String(d.price)) : undefined,
        cost_price: d.cost_price != null ? num(String(d.cost_price)) : undefined,
        stock: d.stock != null ? num(String(d.stock)) : undefined,
        discount_pct: d.discount_pct != null ? num(String(d.discount_pct)) : undefined,
      }),
    });
    const json = await res.json();
    setBusy(null);
    if (!json.ok) return flash("error", json.error ?? "Save failed.");
    setProducts((prev) => prev.map((x) => (x.id === p.id ? (json.data as Product) : x)));
    setDrafts(({ [p.id]: _drop, ...rest }) => rest);
    flash("ok", `${json.data.sku} saved.`);
  };

  const adjust = async (p: Product, delta: number) => {
    const res = await fetch("/api/stock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: p.id, delta, reason: delta > 0 ? "Restock at counter" : "Damage/loss at counter" }),
    });
    const json = await res.json();
    if (!json.ok) return flash("error", json.error ?? "Adjustment failed.");
    setProducts((prev) => prev.map((x) => (x.id === p.id ? (json.data as Product) : x)));
  };

  const remove = async (p: Product) => {
    if (!confirm(`Delete ${p.sku} · ${p.title}? Historical sales keep the line.`)) return;
    const res = await fetch(`/api/products/${p.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.ok) return flash("error", json.error ?? "Delete failed.");
    setProducts((prev) => prev.filter((x) => x.id !== p.id));
    flash("ok", `${p.sku} deleted.`);
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => category === "All" || p.category === category)
      .filter((p) => !lowOnly || p.stock <= p.min_stock)
      .filter((p) => !q || `${p.title} ${p.sku} ${p.barcode} ${p.size}`.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [products, query, category, lowOnly]);

  const cell = (p: Product, key: "price" | "cost_price" | "stock" | "discount_pct") => (
    <input
      value={String(draft(p)[key] ?? p[key])}
      onChange={(e) => setField(p.id, key, e.target.value)}
      onBlur={() => save(p)}
      inputMode="numeric"
      className={`w-24 rounded-lg border px-2 py-1 text-right text-sm tabular-nums ${draft(p)[key] != null ? "border-brass-500 bg-brass-500/10 font-bold" : "border-clay-700/10 bg-sand-50"}`}
      aria-label={`${key} for ${p.sku}`}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-ink-600">{rows.length} of {products.length} SKUs · click a number to edit, blur to save.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="field w-52 pl-9" placeholder="Search SKU, title, barcode" aria-label="Search inventory" />
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="field w-auto" aria-label="Filter by category">
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button onClick={() => setLowOnly((v) => !v)} className={`btn-ghost ${lowOnly ? "border-brass-500 bg-brass-500/15" : ""}`}>
            <AlertTriangle size={15} /> Low stock
          </button>
          <button onClick={() => setEditing("new")} className="btn-primary"><Plus size={15} /> New product</button>
        </div>
      </div>

      {notice && (
        <p className={`rounded-xl border px-3 py-2 text-sm font-semibold ${notice.tone === "ok" ? "border-olive-600/30 bg-olive-50 text-olive-700" : "border-clay-500/30 bg-clay-50 text-clay-600"}`}>{notice.text}</p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[64rem]">
          <thead className="border-b border-clay-700/10 bg-sand-50">
            <tr>
              <th className="th">Item</th>
              <th className="th">Category</th>
              <th className="th text-right">Cost</th>
              <th className="th text-right">Retail</th>
              <th className="th text-right">Disc %</th>
              <th className="th text-right">Margin</th>
              <th className="th text-center">Stock</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const m = computeMargin(p.cost_price, p.price, p.discount_pct);
              const low = p.stock <= p.min_stock;
              return (
                <tr key={p.id} className="border-b border-clay-700/5 last:border-0 hover:bg-sand-50/60">
                  <td className="td">
                    <div className="flex items-center gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.image_url || placeholderImage(p.sku + p.title, p.title)} alt="" className="h-9 w-9 rounded-lg object-cover" />
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{p.title}</p>
                        <p className="font-mono text-[10px] text-ink-600">{p.sku} · {p.barcode} · {p.size}</p>
                      </div>
                      {low && <Badge tone={p.stock === 0 ? "bad" : "warn"}>{p.stock === 0 ? "out" : `${p.stock}`}</Badge>}
                      {!p.active && <Badge tone="neutral">hidden</Badge>}
                    </div>
                  </td>
                  <td className="td text-ink-600">{p.category}</td>
                  <td className="td text-right">{cell(p, "cost_price")}</td>
                  <td className="td text-right">{cell(p, "price")}</td>
                  <td className="td text-right">{cell(p, "discount_pct")}</td>
                  <td className="td text-right">
                    <span className={`tabular-nums font-semibold ${m.marginPct < 30 ? "text-clay-600" : "text-olive-600"}`}>{m.marginPct}%</span>
                    <span className="block text-[10px] text-ink-600">{fmtNumber(m.grossProfit)} / unit</span>
                  </td>
                  <td className="td">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => adjust(p, -1)} className="grid h-7 w-7 place-items-center rounded-lg border border-clay-700/15 hover:bg-clay-50" aria-label={`Remove one ${p.sku}`}><Minus size={13} /></button>
                      {cell(p, "stock")}
                      <button onClick={() => adjust(p, 1)} className="grid h-7 w-7 place-items-center rounded-lg border border-clay-700/15 hover:bg-clay-50" aria-label={`Add one ${p.sku}`}><Plus size={13} /></button>
                    </div>
                  </td>
                  <td className="td">
                    <div className="flex items-center justify-end gap-1">
                      {Object.keys(draft(p)).length > 0 && (
                        <button onClick={() => save(p)} disabled={busy === p.id} className="btn-brass px-2.5 py-1.5 text-xs"><Save size={13} /> {busy === p.id ? "Saving" : "Save"}</button>
                      )}
                      <button onClick={() => setEditing(p)} className="rounded-lg border border-clay-700/15 p-1.5 hover:bg-clay-50" aria-label={`Edit ${p.sku}`}><Pencil size={14} /></button>
                      <button onClick={() => remove(p)} className="rounded-lg border border-clay-500/30 p-1.5 text-clay-500 hover:bg-clay-50" aria-label={`Delete ${p.sku}`}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td className="td text-center text-ink-600" colSpan={8}>No products match this filter.</td></tr>}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-600">
        Stock edits write a stock movement, so the audit trail behind the dashboard stays intact. Total retail value of this view: <strong className="tabular-nums">{fmt(rows.reduce((s, p) => s + p.price * p.stock, 0))}</strong>.
      </p>

      {editing && (
        <ProductEditor
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setProducts((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
            setEditing(null);
            flash("ok", `${p.sku} saved.`);
          }}
        />
      )}
    </div>
  );
}

function ProductEditor({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: (p: Product) => void }) {
  const [form, setForm] = useState({
    title: product?.title ?? "",
    sku: product?.sku ?? "",
    barcode: product?.barcode ?? "",
    category: product?.category ?? "Dresses",
    condition: product?.condition ?? "Good",
    size: product?.size ?? "M",
    description: product?.description ?? "",
    image_url: product?.image_url ?? "",
    cost_price: product?.cost_price ?? 0,
    price: product?.price ?? 0,
    discount_pct: product?.discount_pct ?? 0,
    stock: product?.stock ?? 0,
    min_stock: product?.min_stock ?? 3,
    active: product?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const margin = computeMargin(form.cost_price, form.price, form.discount_pct);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(product ? `/api/products/${product.id}` : "/api/products", {
      method: product ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, image_url: form.image_url || null }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json.ok) return setError(json.error ?? "Save failed.");
    onSaved(json.data as Product);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-clay-700/50 p-3">
      <form onSubmit={submit} className="card my-6 w-full max-w-2xl space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold">{product ? `Edit ${product.sku}` : "New product"}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-clay-50" aria-label="Close editor"><X size={16} /></button>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="pe-title">Title</label>
            <input id="pe-title" required className="field" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pe-sku">SKU</label>
            <input id="pe-sku" className="field font-mono" placeholder="auto if blank" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pe-barcode">Barcode</label>
            <input id="pe-barcode" className="field font-mono" placeholder="auto if blank" value={form.barcode} onChange={(e) => set("barcode", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pe-cat">Category</label>
            <select id="pe-cat" className="field" value={form.category} onChange={(e) => set("category", e.target.value)}>
              {CATEGORIES.filter((c) => c !== "All").map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pe-cond">Condition</label>
            <select id="pe-cond" className="field" value={form.condition} onChange={(e) => set("condition", e.target.value as Product["condition"])}>
              {CONDITIONS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pe-size">Size</label>
            <input id="pe-size" list="size-list" className="field" value={form.size} onChange={(e) => set("size", e.target.value)} />
            <datalist id="size-list">{SIZES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div>
            <label className="label" htmlFor="pe-img">Image URL (optional)</label>
            <input id="pe-img" className="field" placeholder="https://…" value={form.image_url ?? ""} onChange={(e) => set("image_url", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="pe-desc">Description</label>
            <textarea id="pe-desc" rows={2} className="field" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pe-cost">Cost price (UGX)</label>
            <input id="pe-cost" type="number" min={0} step={500} className="field" value={form.cost_price} onChange={(e) => set("cost_price", num(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="pe-price">Retail price (UGX)</label>
            <input id="pe-price" type="number" min={0} step={500} className="field" value={form.price} onChange={(e) => set("price", num(e.target.value))} />
            <div className="mt-1 flex flex-wrap gap-1">
              {[40, 55, 70].map((m) => (
                <button key={m} type="button" onClick={() => set("price", priceForTargetMargin(form.cost_price, m))} className="rounded-md border border-clay-700/15 px-1.5 py-0.5 text-[10px] font-semibold hover:bg-clay-50">
                  price at {m}% margin
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="pe-disc">Discount %</label>
            <input id="pe-disc" type="number" min={0} max={90} className="field" value={form.discount_pct} onChange={(e) => set("discount_pct", num(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="pe-stock">Stock on hand</label>
            <input id="pe-stock" type="number" min={0} className="field" value={form.stock} onChange={(e) => set("stock", num(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="pe-min">Reorder point</label>
            <input id="pe-min" type="number" min={0} className="field" value={form.min_stock} onChange={(e) => set("min_stock", num(e.target.value))} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-semibold">
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Visible in the showroom
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand-50 px-3 py-2 text-sm">
          <span className="text-ink-600">Sells for <strong className="text-ink-900">{fmt(margin.retail)}</strong></span>
          <span className="text-ink-600">Markup <strong className="text-ink-900">{margin.markupPct}%</strong></span>
          <span className="text-ink-600">Margin <strong className={margin.marginPct < 30 ? "text-clay-600" : "text-olive-600"}>{margin.marginPct}%</strong></span>
          <span className="text-ink-600">Profit/unit <strong className="text-ink-900">{fmt(margin.grossProfit)}</strong></span>
        </div>

        {error && <p className="rounded-lg bg-clay-50 px-3 py-2 text-sm font-semibold text-clay-600">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button disabled={busy} className="btn-primary flex-1">{busy ? "Saving…" : "Save product"}</button>
        </div>
      </form>
    </div>
  );
}
