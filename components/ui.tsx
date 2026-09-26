"use client";
import { CURRENCY } from "@/lib/config";
import { fmtNumber } from "@/lib/money";

export const Money = ({ value, className = "" }: { value: number | string; className?: string }) => (
  <span className={className}>
    <span className="text-[0.7em] font-semibold opacity-60">{CURRENCY.symbol}</span> {fmtNumber(value)}
  </span>
);

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "brass" | "olive";
  children: React.ReactNode;
}) {
  // Every tone now comes from the terracotta/olive ramp rather than Tailwind's
  // stock emerald/amber, so the palette stays coherent.
  const tones: Record<string, string> = {
    neutral: "border-clay-700/15 bg-clay-50 text-ink-700",
    good: "border-olive-500/30 bg-olive-50 text-olive-700",
    olive: "border-olive-500/30 bg-olive-50 text-olive-700",
    warn: "border-brass-500/40 bg-brass-500/15 text-brass-600",
    bad: "border-clay-600/30 bg-clay-50 text-clay-600",
    brass: "border-brass-500/40 bg-brass-500/15 text-brass-600",
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function Stat({ label, value, sub, tone = "default" }: { label: string; value: React.ReactNode; sub?: string; tone?: "default" | "brass" }) {
  return (
    <div className={`panel ${tone === "brass" ? "border-clay-700 bg-clay-700 text-sand-50 shadow-lift" : ""}`}>
      <div className={`text-[11px] font-bold uppercase tracking-wide ${tone === "brass" ? "text-sand-100/70" : "text-ink-600"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${tone === "brass" ? "text-sand-100/70" : "text-ink-600"}`}>{sub}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-xl leading-tight">
        {children}
        {/* Olive rule — the one place the secondary accent marks structure. */}
        <span className="mt-1.5 block h-1 w-10 rounded-pill bg-olive-400" aria-hidden />
      </h2>
      {action}
    </div>
  );
}

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="card flex flex-col items-center gap-2 p-10 text-center text-ink-600">{children}</div>
);
