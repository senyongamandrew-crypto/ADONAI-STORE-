"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Layers, Minus, Plus, ScanBarcode, Search, ShoppingCart, Store, Trash2, X } from "lucide-react";
import { CATEGORIES, TENDERS, type Tender } from "@/lib/config";
import { cartTotals, usePosLedger } from "@/lib/cart";
import { useStockStream } from "@/lib/useStockStream";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";
import { changeFor, fmt, quickTenders, unitPrice } from "@/lib/money";
import { placeholderImage } from "@/lib/photo";
import { Badge, Money } from "@/components/ui";
import { Receipt } from "@/components/Receipt";
import type { Product, Profile, Sale } from "@/lib/db/types";

type Feedback = { tone: "ok" | "error"; text: string } | null;

/**
 * Hardware-accelerated cashier terminal.
 * Left: quick-category tabs + touch tiles. Right: live order ledger and settlement.
 * A global keystroke listener catches USB/Bluetooth scanner bursts anywhere on the page.
 */
export function PosTerminal({ initial }: { initial: { products: Product[]; user: Profile } }) {
  const { products: seeded, user } = initial;
  const [products, setProducts] = useState<Product[]>(seeded);
  const [view, setView] = useState<"counter" | "catalogue">("counter");
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [tender, setTender] = useState<Tender>("Cash");
  const [received, setReceived] = useState("");
  const [discount, setDiscount] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const ledger = usePosLedger();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (f: Feedback) => {
    setFeedback(f);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), 2600);
  };

  const refresh = async () => {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setProducts(json.data as Product[]);
    } catch {
      /* keep last known stock */
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  /**
   * Keeps two terminals honest: a sale rung up elsewhere arrives here instantly,
   * and if it eats into the open ticket the cashier is told straight away.
   */
  const stream = useStockStream((event) => {
    setProducts((prev) => prev.map((p) => (p.id === event.product_id ? { ...p, stock: event.stock } : p)));
    const line = usePosLedger.getState().lines.find((l) => l.product_id === event.product_id);
    if (line && line.qty > event.stock) {
      flash({
        tone: "error",
        text: event.stock === 0 ? `${line.title} just sold out elsewhere — remove it from the ticket` : `Only ${event.stock} × ${line.title} left after another sale`,
      });
    }
  });

  /** Scanner burst → inventory match in one pass (barcode, SKU, then title). */
  const handleScan = (raw: string) => {
    const code = raw.trim();
    const low = code.toLowerCase();
    const hit =
      products.find((p) => p.barcode === code || p.sku.toLowerCase() === low) ??
      products.find((p) => p.title.toLowerCase() === low);
    if (!hit) return flash({ tone: "error", text: `No item matches "${code}"` });
    if (hit.stock <= 0) return flash({ tone: "error", text: `${hit.title} (${hit.sku}) is out of stock` });
    const inLedger = ledger.lines.find((l) => l.product_id === hit.id)?.qty ?? 0;
    if (inLedger >= hit.stock) return flash({ tone: "error", text: `Only ${hit.stock} × ${hit.title} available` });
    ledger.add({
      product_id: hit.id,
      sku: hit.sku,
      title: hit.title,
      size: hit.size,
      unit_price: unitPrice(hit.price, hit.discount_pct),
      stock: hit.stock,
    });
    flash({ tone: "ok", text: `${hit.sku} · ${hit.title} — ${fmt(unitPrice(hit.price, hit.discount_pct))}` });
  };

  useBarcodeScanner(handleScan, { enabled: view === "counter" });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => p.active && p.stock > 0)
      .filter((p) => category === "All" || p.category === category)
      .filter((p) => !q || `${p.title} ${p.sku} ${p.size}`.toLowerCase().includes(q))
      .slice(0, 60);
  }, [products, category, search]);

  const { units, subtotal } = cartTotals(ledger.lines);
  const discountCapped = Math.min(discount, subtotal);
  const total = Math.max(0, subtotal - discountCapped);
  const receivedNum = Number(received || 0);
  const change = changeFor(total, receivedNum);

  const addToLedger = (p: Product) => {
    const inLedger = ledger.lines.find((l) => l.product_id === p.id)?.qty ?? 0;
    if (inLedger >= p.stock) return flash({ tone: "error", text: `Only ${p.stock} × ${p.title} available` });
    ledger.add({ product_id: p.id, sku: p.sku, title: p.title, size: p.size, unit_price: unitPrice(p.price, p.discount_pct), stock: p.stock });
    flash({ tone: "ok", text: `${p.sku} · ${p.title} added` });
  };

  const settle = async () => {
    if (!ledger.lines.length) return;
    if (tender === "Cash" && receivedNum < total) return flash({ tone: "error", text: "Cash received is less than the total." });
    setBusy(true);
    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "pos",
          tender,
          status: "completed",
          amount_received: tender === "Cash" ? receivedNum : total,
          discount_total: discountCapped,
          note: null,
          lines: ledger.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price })),
        }),
      });
      const json = await res.json();
      if (!json.ok) return flash({ tone: "error", text: json.error ?? "Checkout failed." });
      setReceipt(json.data as Sale);
      ledger.clear();
      setReceived("");
      setDiscount(0);
      await refresh();
    } catch {
      flash({ tone: "error", text: "Network error — transaction not saved." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-3 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-clay-700/15 bg-sand-50 p-1">
          {(["counter", "catalogue"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold capitalize ${view === v ? "bg-clay-600 text-sand-50" : "text-ink-700 hover:bg-clay-50"}`}
            >
              {v === "counter" ? <ScanBarcode size={15} /> : <Store size={15} />} {v} mode
            </button>
          ))}
        </div>
        <Badge tone={view === "counter" ? "good" : "brass"}>
          {view === "counter" ? "Scanner armed — scan anywhere on this page" : "Customer-facing catalog"}
        </Badge>
        <Badge tone={stream === "live" ? "good" : "neutral"}>
          {stream === "live" ? "Stock live" : stream === "connecting" ? "Connecting" : "Offline"}
        </Badge>
        <span className="ml-auto text-xs text-ink-600">Cashier: <strong>{user.name}</strong></span>
      </div>

      {feedback && (
        <div className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${feedback.tone === "ok" ? "border-olive-600/30 bg-olive-50 text-olive-700" : "border-clay-500/30 bg-clay-50 text-clay-600"}`}>
          {feedback.tone === "ok" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {feedback.text}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* ---------------------------------------------------- LEFT: input panel */}
        <section className="card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} className="field pl-9" placeholder="Find item by name or SKU…" aria-label="Search products" />
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const code = String(data.get("manual") ?? "").trim();
                if (code) handleScan(code);
                e.currentTarget.reset();
              }}
              className="flex gap-1.5"
            >
              <input name="manual" data-scanner="1" className="field w-44" placeholder="Scan / type barcode" aria-label="Barcode" />
              <button className="btn-ghost px-3" type="submit" aria-label="Look up barcode"><ScanBarcode size={15} /></button>
            </form>
          </div>

          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${category === c ? "border-clay-600 bg-clay-600 text-sand-50" : "border-clay-700/15 bg-sand-50 text-ink-700 hover:border-clay-600/45"}`}
              >
                {c}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p className="rounded-xl bg-clay-700/5 p-6 text-center text-sm text-ink-600">No in-stock items match.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p) => {
                const qtyInLedger = ledger.lines.find((l) => l.product_id === p.id)?.qty ?? 0;
                return (
                  <button
                    key={p.id}
                    onClick={() => addToLedger(p)}
                    className="group relative overflow-hidden rounded-xl border border-clay-700/10 bg-sand-50 p-2 text-left transition hover:border-brass-500 hover:shadow-md"
                  >
                    <div className="flex items-start gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.image_url || placeholderImage(p.sku + p.title, p.title)} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-xs font-semibold leading-tight">{p.title}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-600">{p.sku}</p>
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="text-sm font-bold tabular-nums"><Money value={unitPrice(p.price, p.discount_pct)} /></span>
                      <span className={`text-[11px] font-semibold ${p.stock <= p.min_stock ? "text-clay-600" : "text-ink-600"}`}>{p.stock} left</span>
                    </div>
                    {qtyInLedger > 0 && (
                      <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-brass-500 text-[11px] font-bold text-ink-900">{qtyInLedger}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* --------------------------------------------------- RIGHT: live ledger */}
        <aside className="card flex h-fit flex-col lg:sticky lg:top-20">
          <header className="flex items-center justify-between border-b border-clay-700/10 px-3 py-2.5">
            <div>
              <h2 className="font-display text-base font-bold">Current ticket</h2>
              <p className="text-[11px] text-ink-600">{units} item{units === 1 ? "" : "s"}</p>
            </div>
            {ledger.lines.length > 0 && (
              <button onClick={() => ledger.clear()} className="btn-ghost px-2.5 py-1.5 text-xs"><Trash2 size={13} /> Clear</button>
            )}
          </header>

          <div className="max-h-[38vh] overflow-y-auto px-3 py-2 lg:max-h-[34vh]">
            {ledger.lines.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-600">
                <ShoppingCart size={20} className="mx-auto mb-2 opacity-40" />
                Scan an item or tap a tile.
              </p>
            ) : (
              <ul className="space-y-2">
                {ledger.lines.map((l) => (
                  <li key={l.product_id} className="rounded-xl border border-clay-700/10 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{l.title}</p>
                        <p className="font-mono text-[10px] text-ink-600">{l.sku} · {fmt(l.unit_price)}</p>
                      </div>
                      <button onClick={() => ledger.remove(l.product_id)} className="rounded-md p-1 text-clay-500 hover:bg-clay-50" aria-label={`Remove ${l.title}`}><X size={14} /></button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button onClick={() => ledger.setQty(l.product_id, l.qty - 1)} className="grid h-7 w-7 place-items-center rounded-lg border border-clay-700/15" aria-label="Decrease"><Minus size={13} /></button>
                      <span className="w-7 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                      <button onClick={() => ledger.setQty(l.product_id, l.qty + 1)} className="grid h-7 w-7 place-items-center rounded-lg border border-clay-700/15" aria-label="Increase"><Plus size={13} /></button>
                      <span className="ml-auto text-sm font-bold tabular-nums"><Money value={l.unit_price * l.qty} /></span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2.5 border-t border-clay-700/10 bg-sand-50 p-3">
            <div className="space-y-1 text-sm">
              <p className="flex justify-between"><span className="text-ink-600">Subtotal</span><span className="tabular-nums">{fmt(subtotal)}</span></p>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="discount" className="text-ink-600">Discount (UGX)</label>
                <input id="discount" type="number" min={0} step={500} value={discount || ""} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value)))} className="field w-28 py-1 text-right tabular-nums" />
              </div>
              <p className="flex justify-between text-lg font-bold"><span>Total</span><span className="tabular-nums">{fmt(total)}</span></p>
            </div>

            <div>
              <p className="label">Tender</p>
              <div className="grid grid-cols-2 gap-1.5">
                {TENDERS.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTender(t);
                      if (t !== "Cash") setReceived("");
                    }}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${tender === t ? "border-clay-600 bg-clay-600 text-sand-50" : "border-clay-700/15 hover:border-clay-600/45"}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {tender === "Cash" && (
              <div>
                <p className="label">Cash received</p>
                <input
                  value={received}
                  onChange={(e) => setReceived(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="field text-right text-base font-bold tabular-nums"
                  placeholder={String(total)}
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {quickTenders(total).map((q) => (
                    <button key={q} onClick={() => setReceived(String(q))} className="rounded-lg border border-clay-700/15 px-2 py-1 text-[11px] font-semibold hover:bg-clay-50">
                      {fmt(q)}
                    </button>
                  ))}
                </div>
                <p className={`mt-1.5 flex items-center justify-between rounded-lg px-2 py-1 text-sm font-bold ${change > 0 ? "bg-olive-50 text-olive-700" : "bg-clay-700/5 text-ink-700"}`}>
                  <span>Change due</span><span className="tabular-nums">{fmt(change)}</span>
                </p>
              </div>
            )}

            <button onClick={settle} disabled={busy || !ledger.lines.length} className="btn-brass w-full py-3 text-base">
              <Layers size={16} /> {busy ? "Settling…" : `Charge ${fmt(total)}`}
            </button>
            <p className="text-center text-[11px] text-ink-600">Stock is decremented the moment the sale is written.</p>
          </div>
        </aside>
      </div>

      {receipt && <Receipt sale={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
