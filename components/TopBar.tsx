"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, ScanBarcode, ShieldCheck, ShoppingBag, Store } from "lucide-react";
import { CURRENCY, STORE, type Role } from "@/lib/config";
import { cartTotals, useWebCart } from "@/lib/cart";
import { Money } from "@/components/ui";
import type { Profile } from "@/lib/db/types";

const STAFF: Role[] = ["admin", "manager", "cashier"];
const OFFICE: Role[] = ["admin", "manager"];

export function TopBar({ user, mode, showCart = true }: { user: Profile | null; mode: string; showCart?: boolean }) {
  const pathname = usePathname();
  const lines = useWebCart((s) => s.lines);
  const setOpen = useWebCart((s) => s.setOpen);
  const { units, subtotal } = cartTotals(lines);

  const nav = (href: string, label: string, icon: React.ReactNode, allowed: boolean) => {
    if (!allowed) return null;
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-1.5 rounded-pill px-3.5 py-2 text-sm font-semibold transition ${
          active ? "bg-sand-50 text-clay-700" : "text-sand-100/75 hover:bg-sand-50/10 hover:text-sand-50"
        }`}
      >
        {icon}
        {label}
      </Link>
    );
  };

  return (
    <header className="no-print sticky top-0 z-40 border-b border-clay-700/30 bg-clay-700 text-sand-50 shadow-lift">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-2 px-3 py-2.5 sm:px-5">
        <Link href="/" className="mr-2 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-pill bg-brass-500 font-display text-lg font-bold text-clay-700">A</span>
          <span className="leading-tight">
            <span className="block font-display text-[15px] font-bold tracking-wide">{STORE.name}</span>
            <span className="block text-[10px] uppercase tracking-[0.18em] text-sand-100/60">{CURRENCY.code} · Kampala</span>
          </span>
        </Link>

        <nav className="order-3 flex flex-1 flex-wrap items-center gap-1 sm:order-none sm:ml-2">
          {nav("/", "Showroom", <Store size={15} />, true)}
          {nav("/pos", "POS Terminal", <ScanBarcode size={15} />, !!user && STAFF.includes(user.role))}
          {nav("/admin", "Back office", <ShieldCheck size={15} />, !!user && OFFICE.includes(user.role))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* The driver name is an internal detail — only show it to signed-in staff. */}
          <span className="hidden items-center gap-1.5 rounded-pill border border-sand-50/20 px-2.5 py-1 text-[11px] font-semibold text-sand-100/75 md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-pill bg-olive-300" /> {user ? `live stock · ${mode}` : "Stock updated live"}
          </span>
          {showCart && (
            <button onClick={() => setOpen(true)} className="relative inline-flex items-center gap-2 rounded-pill bg-brass-500 px-3.5 py-2 text-sm font-bold text-clay-700 hover:bg-brass-400">
              <ShoppingBag size={16} />
              <span className="hidden sm:inline">Cart</span>
              {units > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-pill bg-ink-900 px-1 text-[11px] font-bold text-sand-50">{units}</span>
              )}
              {units > 0 && <span className="hidden tabular-nums sm:inline">· <Money value={subtotal} /></span>}
            </button>
          )}
          {user ? (
            <form
              action="/api/auth/logout"
              method="post"
              onSubmit={async (e) => {
                e.preventDefault();
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/";
              }}
            >
              <button className="inline-flex items-center gap-1.5 rounded-xl border border-sand-50/25 px-3.5 py-2 text-xs font-semibold text-sand-100/85 hover:bg-sand-50/10">
                <LogOut size={14} /> {user.name.split(" ")[0]}
              </button>
            </form>
          ) : (
            <Link href="/login" className="inline-flex items-center gap-1.5 rounded-xl border border-sand-50/25 px-3.5 py-2 text-xs font-semibold text-sand-100/85 hover:bg-sand-50/10">
              Staff sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
