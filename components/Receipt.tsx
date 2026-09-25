"use client";
import { Printer, Share2, X } from "lucide-react";
import { STORE } from "@/lib/config";
import { fmt } from "@/lib/money";
import { buildOrderMessage } from "@/lib/whatsapp";
import type { Sale } from "@/lib/db/types";

const stamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Kampala" });

/** Receipt & Invoice Generator — thermal-print layout that also dispatches over WhatsApp. */
export function Receipt({ sale, onClose }: { sale: Sale; onClose?: () => void }) {
  const waText = buildOrderMessage(
    sale.lines.map((l) => ({ sku: l.sku, title: l.title, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total })),
    { name: sale.customer_name ?? undefined, phone: sale.customer_phone ?? undefined, note: `Receipt ${sale.ref}` },
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/50 p-3 no-print-bg">
      <div className="print-area card my-6 w-full max-w-sm bg-white p-4">
        <div className="no-print mb-2 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-ink-600">Receipt</span>
          <div className="flex gap-1.5">
            <button onClick={() => window.print()} className="btn-ghost px-2.5 py-1.5 text-xs"><Printer size={13} /> Print</button>
            <a href={`https://wa.me/${(sale.customer_phone || STORE.whatsapp).replace(/[^\d]/g, "")}?text=${encodeURIComponent(waText)}`} target="_blank" rel="noopener noreferrer" className="btn-brass px-2.5 py-1.5 text-xs"><Share2 size={13} /> Send</a>
            {onClose && <button onClick={onClose} className="btn-ghost px-2 py-1.5" aria-label="Close receipt"><X size={14} /></button>}
          </div>
        </div>

        <div className="receipt border-y border-dashed border-ink-900/25 py-3 text-[12px] leading-relaxed">
          <p className="text-center text-sm font-bold tracking-wide">{STORE.name}</p>
          <p className="text-center text-[11px] text-ink-600">{STORE.address} · {STORE.phone}</p>
          <p className="mt-2 flex justify-between"><span>{sale.ref}</span><span>{stamp(sale.created_at)}</span></p>
          <p className="flex justify-between"><span>Served by</span><span>{sale.cashier_name ?? "—"}</span></p>
          <p className="flex justify-between"><span>Channel</span><span>{sale.channel === "pos" ? "Counter" : "Online"}</span></p>

          <table className="mt-2 w-full">
            <thead>
              <tr className="border-y border-dashed border-ink-900/25 text-[10px] uppercase tracking-wide">
                <th className="py-1 text-left">Item</th>
                <th className="py-1 text-right">Qty</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((l) => (
                <tr key={`${l.product_id}-${l.sku}`} className="align-top">
                  <td className="py-1 pr-2">
                    {l.title}
                    <span className="block text-[10px] text-ink-600">{l.sku} · {fmt(l.unit_price)}</span>
                  </td>
                  <td className="py-1 text-right tabular-nums">{l.qty}</td>
                  <td className="py-1 text-right tabular-nums">{fmt(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 space-y-0.5 border-t border-dashed border-ink-900/25 pt-2">
            <p className="flex justify-between"><span>Subtotal</span><span>{fmt(sale.subtotal)}</span></p>
            {sale.discount_total > 0 && <p className="flex justify-between"><span>Discount</span><span>-{fmt(sale.discount_total)}</span></p>}
            <p className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{fmt(sale.total)}</span></p>
            <p className="flex justify-between"><span>{sale.tender ?? "Pending"}</span><span>{fmt(sale.amount_received)}</span></p>
            <p className="flex justify-between font-semibold"><span>Change</span><span>{fmt(sale.change_due)}</span></p>
          </div>
          <p className="mt-3 text-center text-[11px]">Thank you — ASANTE! Exchange within 3 days with receipt.</p>
        </div>
      </div>
    </div>
  );
}
