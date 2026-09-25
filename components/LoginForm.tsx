"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { DEMO_USERS } from "@/lib/config";

export function LoginForm({ mode }: { mode: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent, as?: { email: string; password: string }) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(as ?? { email, password }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json.ok) return setError(json.error ?? "Sign in failed.");
    router.push(json.data.role === "cashier" ? "/pos" : "/admin");
    router.refresh();
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <form onSubmit={submit} className="card space-y-3 p-5">
        <div>
          <h1 className="font-display text-2xl font-bold">Staff sign in</h1>
          <p className="text-sm text-ink-600">Cashiers land on the terminal, managers on the back office.</p>
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" required className="field" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error && <p className="rounded-lg bg-clay-50 px-3 py-2 text-sm font-semibold text-clay-600">{error}</p>}
        <button disabled={busy} className="btn-primary w-full py-3">{busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />} Sign in</button>
      </form>

      {mode === "local" && (
        <div className="card mt-3 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-600">Demo accounts (local driver)</p>
          <ul className="space-y-1.5">
            {DEMO_USERS.map((u) => (
              <li key={u.email}>
                <button
                  onClick={(e) => submit(e, { email: u.email, password: u.password })}
                  className="flex w-full items-center justify-between rounded-lg border border-ink-900/10 px-3 py-2 text-left text-xs hover:bg-ink-900/5"
                >
                  <span>
                    <span className="font-semibold">{u.role}</span> · {u.email}
                  </span>
                  <span className="font-mono text-[11px] text-ink-600">{u.password}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-600">Once you add Supabase keys the app authenticates against Supabase Auth instead.</p>
        </div>
      )}
    </div>
  );
}
