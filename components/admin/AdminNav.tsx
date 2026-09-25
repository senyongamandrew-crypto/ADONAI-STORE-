"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Boxes, Receipt, Tags } from "lucide-react";

const LINKS = [
  { href: "/admin", label: "Dashboard", icon: <BarChart3 size={15} /> },
  { href: "/admin/inventory", label: "Inventory", icon: <Boxes size={15} /> },
  { href: "/admin/sales", label: "Sales", icon: <Receipt size={15} /> },
  { href: "/admin/labels", label: "Barcode labels", icon: <Tags size={15} /> },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="no-print mb-4 flex gap-1.5 overflow-x-auto rounded-xl border border-ink-900/10 bg-white p-1">
      {LINKS.map((l) => {
        const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${active ? "bg-ink-900 text-[#faf7f2]" : "text-ink-700 hover:bg-ink-900/5"}`}
          >
            {l.icon} {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
