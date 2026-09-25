"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { MessageCircle, Minus, Plus, Trash2, X } from "lucide-react";
import { STORE } from "@/lib/config";
import { cartTotals, useWebCart } from "@/lib/cart";
import { whatsappChatUrl, whatsappOrderUrl } from "@/lib/whatsapp";
import { fmt, unitPrice } from "@/lib/money";
import { Empty, Money } from "@/components/ui";

/**
 * Flyout Cart Drawer + WhatsApp Order Orchestrator.
 * Line items are encoded into a structured message and dispatched to the store number.
 */
export function CartDrawer() {
  const { lines, open, setOpen, setQty, remove, clear } = useWebCart();
  const [customer, setCustomer] = useState({ name: "", phone: "", note: "" });
  const { units, subtotal } = cartTotals(lines);

  const orderLines = useMemo(
    () => lines.map((l) => ({ sku: l.sku, title: l.title, size: l.size, qty: l.qty, unit_price: l.unit_price, line_total: l.unit_price * l.qty })),
    [lines],
  );
  const href = useMemo(() => whatsappOrderUrl(orderLines, customer), [orderLines, customer]);
  const oversold = lines.filter((l) => l.qty > l.stock);

  return (
    <>
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-ink-900/45 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[26rem] flex-col bg-[#faf7f2] shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <header className="flex items-center justify-between border-b border-ink-900/10 px-4 py-3">
          <div>
            <h2 className="font-display text-lg font-bold">Your basket</h2>
            <p className="text-xs text-ink-600">{units} item{units === 1 ? "" : "s"} · {fmt(subtotal)}</p>
          </div>
          <button onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-ink-900/5" aria-label="Close cart"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!lines.length ? (
            <Empty>
              <p className="text-sm">Nothing here yet. Add pieces from the rail and they will appear in this drawer.</p>
              <a href={whatsappChatUrl()} target="_blank" rel="noopener noreferrer" className="btn-ghost mt-1 py-1.5 text-xs">
                Ask the shop a question on WhatsApp
              </a>
            </Empty>
          ) : (
            <ul className="space-y-2.5">
              {lines.map((l) => (
                <li key={l.product_id} className="card flex gap-3 p-2.5">
                  <div className="w-14 shrink-0 text-center">
                    <div className="font-mono text-[10px] text-ink-600">{l.sku}</div>
                    <div className="mt-1 text-base font-bold tabular-nums">{l.qty}×</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{l.title}</p>
                    <p className="text-xs text-ink-600">Size {l.size} · <Money value={l.unit_price} /> each</p>
                    {l.qty > l.stock && <p className="mt-0.5 text-[11px] font-semibold text-clay-600">Only {l.stock} in stock now</p>}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button onClick={() => setQty(l.product_id, l.qty - 1)} className="grid h-7 w-7 place-items-center rounded-lg border border-ink-900/15 hover:bg-ink-900/5" aria-label="Decrease quantity"><Minus size={13} /></button>
                      <span className="w-8 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                      <button onClick={() => setQty(l.product_id, l.qty + 1)} className="grid h-7 w-7 place-items-center rounded-lg border border-ink-900/15 hover:bg-ink-900/5" aria-label="Increase quantity"><Plus size={13} /></button>
                      <span className="ml-auto text-sm font-bold tabular-nums"><Money value={l.unit_price * l.qty} /></span>
                      <button onClick={() => remove(l.product_id)} className="rounded-lg p-1.5 text-clay-500 hover:bg-clay-50" aria-label={`Remove ${l.title}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!!lines.length && (
          <footer className="space-y-2.5 border-t border-ink-900/10 bg-white px-4 py-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="cart-name">Name</label>
                <input id="cart-name" className="field" placeholder="Optional" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="cart-phone">Phone</label>
                <input id="cart-phone" className="field" placeholder="07XX XXX XXX" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="cart-note">Note for the shop</label>
              <input id="cart-note" className="field" placeholder="Delivery / pickup / reserve until Friday" value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} />
            </div>

            <div className="flex items-end justify-between pt-1">
              <span className="text-xs uppercase tracking-wide text-ink-600">Total</span>
              <span className="text-xl font-bold tabular-nums"><Money value={subtotal} /></span>
            </div>

            <a href={href} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(() => clear(), 800)} className="btn-brass w-full py-3">
              <MessageCircle size={17} /> Send order on WhatsApp
            </a>
            <p className="text-center text-[11px] leading-relaxed text-ink-600">
              Opens WhatsApp with your items, quantities and total pre-written to {STORE.whatsapp}. Stock is confirmed by the shop before payment.
            </p>
            <button onClick={clear} className="w-full text-center text-[11px] font-semibold text-ink-600 underline">Clear basket</button>
            {oversold.length > 0 && <p className="text-[11px] font-semibold text-clay-600">Some quantities exceed current stock — the shop will confirm what is available.</p>}
          </footer>
        )}
      </aside>
    </>
  );
}

/** Compact link used where a full drawer is overkill. */
export const WhatsAppLink = ({ text }: { text: string }) => (
  <Link href={`https://wa.me/${STORE.whatsapp.replace(/[^\d]/g, "")}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
    message the shop
  </Link>
);
