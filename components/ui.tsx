"use client";
import { CURRENCY } from "@/lib/config";
import { fmtNumber } from "@/lib/money";

export const Money = ({ value, className = "" }: { value: number | string; className?: string }) => (
  <span className={className}>
    <span className="text-[0.7em] font-semibold opacity-60">{CURRENCY.symbol}</span> {fmtNumber(value)}
  </span>
);

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "brass"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "border-ink-900/15 bg-ink-900/5 text-ink-700",
    good: "border-emerald-600/25 bg-emerald-50 text-emerald-800",
    warn: "border-amber-600/30 bg-amber-50 text-amber-800",
    bad: "border-clay-500/30 bg-clay-50 text-clay-600",
    brass: "border-brass-500/40 bg-brass-500/15 text-brass-600",
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function Stat({ label, value, sub, tone = "default" }: { label: string; value: React.ReactNode; sub?: string; tone?: "default" | "brass" }) {
  return (
    <div className={`card p-4 ${tone === "brass" ? "bg-ink-900 text-[#faf7f2]" : ""}`}>
      <div className={`text-[11px] font-bold uppercase tracking-wide ${tone === "brass" ? "text-[#faf7f2]/60" : "text-ink-600"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${tone === "brass" ? "text-[#faf7f2]/60" : "text-ink-600"}`}>{sub}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="font-display text-xl font-bold">{children}</h2>
      {action}
    </div>
  );
}

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="card flex flex-col items-center gap-2 p-10 text-center text-ink-600">{children}</div>
);
