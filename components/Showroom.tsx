"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Filter, RefreshCw, Search } from "lucide-react";
import { CATEGORIES } from "@/lib/config";
import { useWebCart } from "@/lib/cart";
import { useStockStream } from "@/lib/useStockStream";
import { unitPrice } from "@/lib/money";
import { ProductCard } from "@/components/ProductCard";
import { CartDrawer } from "@/components/CartDrawer";
import { Badge, Empty } from "@/components/ui";
import type { Product } from "@/lib/db/types";
import type { Profile } from "@/lib/db/types";

type Sort = "featured" | "price-asc" | "price-desc" | "newest";

/**
 * Customer-facing digital showroom: sticky search rail, category filtering,
 * fluid product grid and out-of-stock mirroring against the live database.
 */
export function Showroom({ initial }: { initial: { products: Product[]; user: Profile | null } }) {
  const [products, setProducts] = useState<Product[]>(initial.products);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState<Sort>("featured");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const add = useWebCart((s) => s.add);

  /** Full re-read from the API — initial load, reconnect, and unknown-product pushes. */
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) return;
      const live = json.data as Product[];
      const byId = new Map(live.map((p) => [p.id, p]));
      setProducts((prev) => {
        const merged = prev
          .map((p) => (byId.has(p.id) ? byId.get(p.id)! : { ...p, active: false }))
          .filter((p) => p.active);
        for (const p of live) if (!merged.some((m) => m.id === p.id)) merged.push(p);
        return merged;
      });
    } catch {
      /* offline — keep showing the last known catalog */
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    sync();
    // Backstop for the window between a dropped stream and its reconnect.
    const id = setInterval(sync, 60_000);
    return () => clearInterval(id);
  }, [sync]);

  /**
   * Out-of-stock mirroring: the counter publishes on every sale, so a piece sold
   * in store flips to "Sold out" here without a reload.
   */
  const stream = useStockStream((event) => {
    setProducts((prev) => {
      const known = prev.some((p) => p.id === event.product_id);
      if (!known) {
        void sync(); // new or deleted product — take the full snapshot
        return prev;
      }
      return prev.map((p) => (p.id === event.product_id ? { ...p, stock: event.stock } : p));
    });
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = products.filter((p) => p.active);
    if (inStockOnly) rows = rows.filter((p) => p.stock > 0);
    if (category !== "All") rows = rows.filter((p) => p.category === category);
    if (q) rows = rows.filter((p) => `${p.title} ${p.sku} ${p.category} ${p.size} ${p.condition}`.toLowerCase().includes(q));
    const sorted = [...rows];
    if (sort === "price-asc") sorted.sort((a, b) => unitPrice(a.price, a.discount_pct) - unitPrice(b.price, b.discount_pct));
    if (sort === "price-desc") sorted.sort((a, b) => unitPrice(b.price, b.discount_pct) - unitPrice(a.price, a.discount_pct));
    if (sort === "newest") sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (sort === "featured") sorted.sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || a.title.localeCompare(b.title));
    return sorted;
  }, [products, query, category, sort, inStockOnly]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) if (p.active && p.stock > 0) map.set(p.category, (map.get(p.category) ?? 0) + 1);
    return map;
  }, [products]);

  return (
    <div className="pb-24">
      <section className="border-b border-ink-900/10 bg-white">
        <div className="mx-auto max-w-[1400px] px-3 py-4 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, SKU, size, condition…"
                className="field pl-9"
                aria-label="Search the catalog"
              />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="field w-auto" aria-label="Sort products">
              <option value="featured">Featured</option>
              <option value="newest">Newest in</option>
              <option value="price-asc">Price: low → high</option>
              <option value="price-desc">Price: high → low</option>
            </select>
            <button onClick={() => setInStockOnly((v) => !v)} className={`btn-ghost ${inStockOnly ? "border-brass-500 bg-brass-500/15" : ""}`}>
              <Filter size={15} /> In stock
            </button>
            <span
              className="inline-flex items-center gap-1.5 text-xs text-ink-600"
              title={
                stream === "live"
                  ? "Live: stock updates the moment something sells at the counter"
                  : stream === "connecting"
                    ? "Connecting to live stock"
                    : "Live updates unavailable — refreshing every minute"
              }
            >
              <span className={`h-1.5 w-1.5 rounded-full ${stream === "live" ? "bg-olive-500" : stream === "connecting" ? "bg-brass-500" : "bg-ink-600/40"}`} />
              {stream === "live" ? "Live stock" : stream === "connecting" ? "Connecting" : "Offline"}
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> {visible.length} shown
            </span>
          </div>

          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map((c) => {
              const active = category === c;
              const n = c === "All" ? products.filter((p) => p.active && p.stock > 0).length : (counts.get(c) ?? 0);
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    active ? "border-clay-600 bg-clay-600 text-sand-50" : "border-clay-700/15 bg-sand-50 text-ink-700 hover:border-clay-600/45"
                  }`}
                >
                  {c} <span className="opacity-50">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-[1400px] px-3 py-5 sm:px-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-[1.75rem] leading-tight">{category === "All" ? "The rail" : category}</h2>
            <p className="mt-1.5 max-w-xl text-[15px] leading-[1.6] text-ink-600">
              One of each, exactly as photographed. Send your basket to WhatsApp and we will confirm
              it is still here.
            </p>
          </div>
          <Badge tone="brass">Prices in UGX · stock shared with the counter</Badge>
        </div>

        {visible.length === 0 ? (
          <Empty>
            <p className="text-[15px] font-semibold text-ink-900">Nothing on the rail matches that.</p>
            <p className="max-w-sm text-[15px] leading-[1.6]">
              New bales are opened most weeks. Tell us what you are after and we will watch for it.
            </p>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onAdd={(prod) =>
                  add(
                    {
                      product_id: prod.id,
                      sku: prod.sku,
                      title: prod.title,
                      size: prod.size,
                      unit_price: unitPrice(prod.price, prod.discount_pct),
                      stock: prod.stock,
                    },
                    1,
                  )
                }
              />
            ))}
          </div>
        )}
      </main>

      <CartDrawer />
    </div>
  );
}
