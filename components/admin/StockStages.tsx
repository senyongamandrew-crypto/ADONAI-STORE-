"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, ClipboardCheck, Minus, Plus, RefreshCw, Shirt } from "lucide-react";
import { useStockStream } from "@/lib/useStockStream";
import { Badge, Empty, Stat } from "@/components/ui";
import type { HoldBucket } from "@/lib/db/store";
import type { Product } from "@/lib/db/types";

type Tab = Extract<HoldBucket, "on_trial" | "in_inspection">;

const TABS: { id: Tab; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "on_trial", label: "Trial", hint: "Fitting room · on demo", icon: <Shirt size={15} /> },
  { id: "in_inspection", label: "Inspection", hint: "Pending QC", icon: <ClipboardCheck size={15} /> },
];

/**
 * Trial & Inspection workspace.
 *
 * Both tabs read the same live snapshot as the public showroom and the POS: an
 * SSE push from any write updates the counters here without a reload, so a
 * piece pulled onto the fitting-room rail in one place is reflected in the
 * other instantly. Counts are advisory — sellable stock is never touched, so
 * the counter can still ring up a piece that is in either place.
 */
export function StockStages({ initial }: { initial: Product[] }) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [tab, setTab] = useState<Tab>("on_trial");
  const [onlyHeld, setOnlyHeld] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPush, setLastPush] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const res = await fetch("/api/products?scope=admin");
    const json = await res.json();
    if (json.ok) setProducts(json.data);
  }, []);

  // Live: patch the row the push is about; fall back to a full snapshot for ids
  // this page has not seen (a product added in another tab).
  const stream = useStockStream((event) => {
    setLastPush(`${event.sku} · ${event.reason}`);
    setProducts((prev) => {
      if (!prev.some((p) => p.id === event.product_id)) {
        void sync();
        return prev;
      }
      return prev.map((p) =>
        p.id === event.product_id
          ? {
              ...p,
              stock: event.stock,
              on_trial: event.on_trial ?? p.on_trial,
              in_inspection: event.in_inspection ?? p.in_inspection,
              min_stock: event.min_stock ?? p.min_stock,
            }
          : p,
      );
    });
  });

  // Backstop for the gap between a dropped connection and its reconnect.
  useEffect(() => {
    const t = setInterval(() => void sync(), 60_000);
    return () => clearInterval(t);
  }, [sync]);

  const totals = useMemo(() => {
    const active = products.filter((p) => p.active);
    return {
      available: active.reduce((n, p) => n + p.stock, 0),
      trial: active.reduce((n, p) => n + p.on_trial, 0),
      inspection: active.reduce((n, p) => n + p.in_inspection, 0),
      low: active.filter((p) => p.stock <= p.min_stock).length,
    };
  }, [products]);

  const rows = useMemo(() => {
    const other: Tab = tab === "on_trial" ? "in_inspection" : "on_trial";
    let list = [...products];
    if (onlyHeld) list = list.filter((p) => p[tab] > 0);
    return list
      .sort((a, b) => b[tab] - a[tab] || a.sku.localeCompare(b.sku))
      .map((p) => ({ p, reserved: p[other] }));
  }, [products, tab, onlyHeld]);

  const setCount = async (p: Product, next: number) => {
    if (next < 0) return;
    setError(null);
    setBusy(p.id);
    // Optimistic so the table responds to the click, not to the round trip.
    const before = p[tab];
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, [tab]: next } : x)));
    try {
      const res = await fetch("/api/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product_id: p.id, bucket: tab, count: next }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Could not update.");
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...json.data } : x)));
    } catch (e) {
      setError((e as Error).message);
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, [tab]: before } : x)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Trial &amp; Inspection</h1>
          <p className="text-sm text-ink-600">
            Where every unit physically is. These counts are advisory — they never reduce what the counter can sell.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span
            className={`inline-block size-2 rounded-full ${
              stream === "live" ? "bg-olive-500" : stream === "connecting" ? "bg-brass-500" : "bg-clay-500"
            }`}
          />
          <span className="text-ink-600">
            {stream === "live" ? "Live sync" : stream === "connecting" ? "Connecting" : "Offline"}
          </span>
          <button onClick={() => void sync()} className="btn-ghost px-2 py-1 text-xs" title="Refresh now">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {lastPush && <p className="text-xs text-ink-600">Last push: {lastPush}</p>}
      {error && <p className="rounded-lg bg-clay-50 px-3 py-2 text-sm font-semibold text-clay-600">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Available stock" value={totals.available} sub={`${products.filter((p) => p.active).length} live products`} />
        <Stat label="In trial / on demo" value={totals.trial} sub="fitting room rail" tone="brass" />
        <Stat label="Under inspection" value={totals.inspection} sub="pending QC" tone="brass" />
        <Stat label="At or below min stock" value={totals.low} sub="needs a top-up" />
      </div>

      <div className="panel">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {TABS.map((t) => {
            const active = tab === t.id;
            const count = t.id === "on_trial" ? totals.trial : totals.inspection;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
                  active ? "bg-clay-600 text-sand-50" : "text-ink-700 hover:bg-clay-50"
                }`}
              >
                {t.icon} {t.label}
                <span className={`rounded-full px-1.5 text-[11px] ${active ? "bg-white/15" : "bg-clay-700/10"}`}>{count}</span>
              </button>
            );
          })}
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-600">
            <input type="checkbox" className="size-4 accent-ink-900" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />
            Only items on this rail
          </label>
        </div>

        <p className="mb-3 text-xs text-ink-600">{TABS.find((t) => t.id === tab)?.hint}</p>

        {rows.length === 0 ? (
          <Empty>
            Nothing on the {tab === "on_trial" ? "trial rail" : "QC bench"}.{" "}
            <button className="font-semibold underline" onClick={() => setOnlyHeld(false)}>
              Show all products
            </button>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-clay-700/10">
                  <th className="th">SKU</th>
                  <th className="th">Item</th>
                  <th className="th">Available</th>
                  <th className="th">Flags</th>
                  <th className="th text-right">
                    {tab === "on_trial" ? "In trial" : "In inspection"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, reserved }) => {
                  const low = p.stock <= p.min_stock;
                  return (
                    <tr key={p.id} className="border-b border-clay-700/5 last:border-0">
                      <td className="td font-mono text-[12px]">{p.sku}</td>
                      <td className="td">
                        <div className="font-medium">{p.title}</div>
                        <div className="text-xs text-ink-600">
                          {p.category} · {p.condition} · Size {p.size}
                        </div>
                      </td>
                      <td className="td">
                        <span className="inline-flex items-center gap-1.5">
                          <Boxes size={14} className="text-ink-600" />
                          {p.stock}
                        </span>
                      </td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          {p.stock === 0 && <Badge tone="bad">Sold out</Badge>}
                          {p.stock > 0 && low && <Badge tone="warn">Low · min {p.min_stock}</Badge>}
                          {reserved > 0 && (
                            <Badge tone="brass">{reserved} {tab === "on_trial" ? "in QC" : "on trial"}</Badge>
                          )}
                          {!p.active && <Badge>Hidden from site</Badge>}
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => void setCount(p, p[tab] - 1)}
                            disabled={busy === p.id || p[tab] === 0}
                            className="btn-ghost px-2 py-1"
                            aria-label={`One fewer ${tab === "on_trial" ? "in trial" : "in inspection"}`}
                          >
                            <Minus size={14} />
                          </button>
                          <span className="min-w-6 text-center font-mono text-sm font-semibold">{p[tab]}</span>
                          <button
                            onClick={() => void setCount(p, p[tab] + 1)}
                            disabled={busy === p.id}
                            className="btn-ghost px-2 py-1"
                            aria-label={`One more ${tab === "on_trial" ? "in trial" : "in inspection"}`}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
