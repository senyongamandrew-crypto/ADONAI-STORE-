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
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
          active ? "bg-[#faf7f2] text-ink-900" : "text-[#faf7f2]/70 hover:bg-[#faf7f2]/10 hover:text-[#faf7f2]"
        }`}
      >
        {icon}
        {label}
      </Link>
    );
  };

  return (
    <header className="no-print sticky top-0 z-40 border-b border-black/20 bg-ink-900 text-[#faf7f2]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-2 px-3 py-2.5 sm:px-5">
        <Link href="/" className="mr-2 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brass-500 font-display text-lg font-bold text-ink-900">A</span>
          <span className="leading-tight">
            <span className="block font-display text-[15px] font-bold tracking-wide">{STORE.name}</span>
            <span className="block text-[10px] uppercase tracking-[0.18em] text-[#faf7f2]/50">{CURRENCY.code} · Kampala</span>
          </span>
        </Link>

        <nav className="order-3 flex flex-1 flex-wrap items-center gap-1 sm:order-none sm:ml-2">
          {nav("/", "Showroom", <Store size={15} />, true)}
          {nav("/pos", "POS Terminal", <ScanBarcode size={15} />, !!user && STAFF.includes(user.role))}
          {nav("/admin", "Back office", <ShieldCheck size={15} />, !!user && OFFICE.includes(user.role))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* The driver name is an internal detail — only show it to signed-in staff. */}
          <span className="hidden items-center gap-1.5 rounded-full border border-[#faf7f2]/15 px-2.5 py-1 text-[11px] font-semibold text-[#faf7f2]/70 md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> {user ? `live stock · ${mode}` : "Stock updated live"}
          </span>
          {showCart && (
            <button onClick={() => setOpen(true)} className="relative inline-flex items-center gap-2 rounded-xl bg-brass-500 px-3 py-2 text-sm font-bold text-ink-900 hover:bg-brass-400">
              <ShoppingBag size={16} />
              <span className="hidden sm:inline">Cart</span>
              {units > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-clay-500 px-1 text-[11px] font-bold text-white">{units}</span>
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
              <button className="inline-flex items-center gap-1.5 rounded-xl border border-[#faf7f2]/20 px-3 py-2 text-xs font-semibold text-[#faf7f2]/80 hover:bg-[#faf7f2]/10">
                <LogOut size={14} /> {user.name.split(" ")[0]}
              </button>
            </form>
          ) : (
            <Link href="/login" className="inline-flex items-center gap-1.5 rounded-xl border border-[#faf7f2]/20 px-3 py-2 text-xs font-semibold text-[#faf7f2]/80 hover:bg-[#faf7f2]/10">
              Staff sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
