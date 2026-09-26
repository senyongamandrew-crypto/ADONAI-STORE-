"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Loader2, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { Badge, Empty } from "@/components/ui";
import type { PasskeyCredential, Profile, UserSummary } from "@/lib/db/types";

/** Passkey rows are returned without `public_key` by the admin endpoints. */
type SafePasskey = Omit<PasskeyCredential, "public_key">;

const rel = (iso: string | null) => {
  if (!iso) return "never used";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
};

const deviceLabel = (k: SafePasskey) =>
  k.device_type === "multiDevice" ? "Synced (iCloud / Google)" : k.device_type === "singleDevice" ? "This device only" : "Unknown device";

/**
 * Security & Passkeys.
 *
 * Everyone signed in manages their own credentials here. The staff table and the
 * revoke / reset actions are rendered for admins, and — more importantly — the
 * endpoints behind them require the admin role server-side, so the UI is never
 * the only gate.
 */
export function SecurityPanel({ me }: { me: Profile }) {
  const isAdmin = me.role === "admin";
  const [mine, setMine] = useState<SafePasskey[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [roster, setRoster] = useState<SafePasskey[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    const own = await fetch("/api/auth/passkey").then((r) => r.json());
    if (own?.ok) setMine((own.data as PasskeyCredential[]).map(({ public_key: _pk, ...rest }) => rest));
  }, []);

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;
    const [u, k] = await Promise.all([
      fetch("/api/admin/users").then((r) => r.json()),
      fetch("/api/admin/passkeys").then((r) => r.json()),
    ]);
    if (u?.ok) setUsers(u.data);
    if (k?.ok) setRoster(k.data);
  }, [isAdmin]);

  useEffect(() => {
    void load();
    void loadAdmin();
  }, [load, loadAdmin]);

  const act = async (key: string, run: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    setBusy(key);
    try {
      setNotice(await run());
      await load();
      await loadAdmin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const enrol = () =>
    act("enrol", async () => {
      const begin = await fetch("/api/auth/passkey/register/begin", { method: "POST" }).then((r) => r.json());
      if (!begin.ok) throw new Error(begin.error ?? "Could not start enrolment.");
      let credential;
      try {
        credential = await startRegistration({ optionsJSON: begin.data.options });
      } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") throw new Error("That authenticator is already registered.");
        if (err.name === "ERROR_CEREMONY_ABORTED") throw new Error("Enrolment was cancelled.");
        if (err.name === "ERROR_WEB_AUTHN_NOT_SUPPORTED") throw new Error("This browser does not support passkeys.");
        throw new Error(err.message || "Enrolment failed.");
      }
      const done = await fetch("/api/auth/passkey/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential, name: label || undefined }),
      }).then((r) => r.json());
      if (!done.ok) throw new Error(done.error ?? "That passkey could not be verified.");
      setLabel("");
      return `Passkey "${done.data.name}" added. Sign in with it from now on.`;
    });

  const removeOwn = (k: SafePasskey) =>
    act(k.id, async () => {
      const res = await fetch(`/api/auth/passkey/${encodeURIComponent(k.id)}`, { method: "DELETE" }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error ?? "Could not remove that passkey.");
      return `"${k.name}" removed.`;
    });

  const revoke = (k: SafePasskey, killSessions: boolean) =>
    act(k.id, async () => {
      const res = await fetch(`/api/admin/passkeys/${encodeURIComponent(k.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invalidate_sessions: killSessions }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error ?? "Could not revoke that passkey.");
      return `"${k.name}" revoked for ${k.user_email ?? "that user"}${killSessions ? ", and their sessions were cut." : "."}`;
    });

  const resetAll = (u: UserSummary) =>
    act(`reset-${u.id}`, async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}/passkeys/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invalidate_sessions: true }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error ?? "Could not reset those passkeys.");
      return `${res.data.revoked} passkey(s) revoked for ${u.email}. They can sign in with their password and re-enrol.`;
    });

  const rowsFor = (userId: string) => roster.filter((k) => k.user_id === userId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold">Security &amp; Passkeys</h1>
        <p className="text-sm text-ink-600">
          Passkeys sign in with the device itself — fingerprint, face or PIN — instead of a shared password. The
          password path keeps working unchanged.
        </p>
      </div>

      {error && <p className="rounded-lg bg-clay-50 px-3 py-2 text-sm font-semibold text-clay-600">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">{notice}</p>}

      <div className="panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="card-heading">My passkeys</h2>
          <button onClick={() => void load()} className="btn-ghost px-2 py-1 text-xs">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label className="label" htmlFor="pk-label">Name this device (optional)</label>
            <input
              id="pk-label"
              className="field"
              placeholder="Front-counter tablet"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
            />
          </div>
          <button onClick={() => void enrol()} disabled={busy === "enrol"} className="btn-primary">
            {busy === "enrol" ? <Loader2 size={16} className="animate-spin" /> : <Fingerprint size={16} />}
            Add a passkey
          </button>
        </div>

        {mine.length === 0 ? (
          <Empty>No passkeys on your account yet. Add one and the login screen will offer it.</Empty>
        ) : (
          <ul className="divide-y divide-ink-900/5">
            {mine.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <Fingerprint size={16} className={k.revoked_at ? "text-ink-600/40" : "text-ink-900"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{k.name}</div>
                  <div className="text-xs text-ink-600">
                    {deviceLabel(k)} · added {rel(k.created_at)} · used {rel(k.last_used_at)}
                  </div>
                </div>
                {k.revoked_at ? <Badge tone="bad">Revoked {rel(k.revoked_at)}</Badge> : <Badge tone="good">Active</Badge>}
                {!k.revoked_at && (
                  <button onClick={() => void removeOwn(k)} disabled={busy === k.id} className="btn-ghost px-2 py-1 text-xs">
                    <Trash2 size={13} /> Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin ? (
        <div className="panel">
          <h2 className="card-heading mb-3">Staff passkeys — administrative override</h2>
          <p className="mb-4 text-xs text-ink-600">
            Revoking also cuts that person&apos;s signed-in sessions by default, so a lost device stops working
            immediately rather than when its cookie expires in 12 hours. Password sign-in is never disabled, so nobody
            is locked out.
          </p>
          {users.length === 0 ? (
            <Empty>No staff accounts found.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="border-b border-ink-900/10">
                    <th className="th">Staff</th>
                    <th className="th">Role</th>
                    <th className="th">Passkeys</th>
                    <th className="th">Last used</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const keys = rowsFor(u.id);
                    const open = expanded === u.id;
                    return (
                      <Fragment key={u.id}>
                        <tr className="border-b border-ink-900/5">
                          <td className="td">
                            <div className="font-medium">{u.name || u.email}</div>
                            <div className="text-xs text-ink-600">{u.email}</div>
                          </td>
                          <td className="td">
                            <Badge tone={u.role === "admin" ? "brass" : "neutral"}>{u.role}</Badge>
                          </td>
                          <td className="td">
                            <button
                              onClick={() => setExpanded(open ? null : u.id)}
                              className="inline-flex items-center gap-2 font-semibold underline decoration-dotted"
                            >
                              {u.active_passkeys} active
                              {u.revoked_passkeys > 0 && <span className="text-ink-600">({u.revoked_passkeys} revoked)</span>}
                            </button>
                          </td>
                          <td className="td text-xs text-ink-600">{rel(u.last_used_at)}</td>
                          <td className="td">
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => void resetAll(u)}
                                disabled={busy === `reset-${u.id}` || u.active_passkeys === 0}
                                className="btn-ghost px-2 py-1 text-xs"
                              >
                                {busy === `reset-${u.id}` ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
                                Reset all
                              </button>
                            </div>
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={5} className="bg-ink-900/[0.03] px-3 py-2">
                              {keys.length === 0 ? (
                                <p className="py-1 text-xs text-ink-600">No registrations for this account.</p>
                              ) : (
                                <ul className="divide-y divide-ink-900/5">
                                  {keys.map((k) => (
                                    <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
                                      <Fingerprint size={14} className={k.revoked_at ? "text-ink-600/40" : "text-ink-900"} />
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-semibold">{k.name}</div>
                                        <div className="text-xs text-ink-600">
                                          {deviceLabel(k)} · added {rel(k.created_at)} · used {rel(k.last_used_at)}
                                          {k.backed_up ? " · backed up" : ""}
                                        </div>
                                      </div>
                                      {k.revoked_at ? (
                                        <Badge tone="bad">Revoked by {k.revoked_by ?? "admin"}</Badge>
                                      ) : (
                                        <>
                                          <Badge tone="good">Active</Badge>
                                          <button onClick={() => void revoke(k, true)} disabled={busy === k.id} className="btn-ghost px-2 py-1 text-xs">
                                            Revoke + cut sessions
                                          </button>
                                          <button onClick={() => void revoke(k, false)} disabled={busy === k.id} className="btn-ghost px-2 py-1 text-xs">
                                            Revoke only
                                          </button>
                                        </>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="panel">
          <h2 className="card-heading mb-2">Managing other people&apos;s passkeys</h2>
          <p className="text-sm text-ink-600">
            Only administrators can view, revoke or reset another account&apos;s passkeys. You can manage your own above.
          </p>
        </div>
      )}
    </div>
  );
}
