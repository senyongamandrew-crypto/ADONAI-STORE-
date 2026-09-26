import "server-only";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import type { Profile } from "@/lib/db/types";

/**
 * WebAuthn (passkey) core.
 *
 * Sits above the data layer: this module owns the ceremony, the challenge
 * lifecycle and the rpID/origin binding. Persistence goes through `Store`, so
 * local-demo and Supabase behave identically.
 */

export const RP_NAME = "ADONAI THRIFT";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

type PendingChallenge = { kind: "registration" | "authentication"; userId: string | null; expires: number };

/**
 * One-time challenge store.
 *
 * In-process, like lib/ratelimit.ts — a challenge issued by one Node process is
 * only redeemable there, so this assumes a single instance (or sticky routing).
 * Swap for Redis/Postgres if the app is ever scaled out; nothing else changes.
 */
const pending = new Map<string, PendingChallenge>();

const sweep = () => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
};

function putChallenge(kind: PendingChallenge["kind"], challenge: string, userId: string | null) {
  sweep();
  pending.set(challenge, { kind, userId, expires: Date.now() + CHALLENGE_TTL_MS });
}

/** Consumes: a challenge can never be replayed, and must match kind + owner. */
function takeChallenge(challenge: string, kind: PendingChallenge["kind"], userId: string | null): boolean {
  const entry = pending.get(challenge);
  if (!entry) return false;
  pending.delete(challenge);
  if (entry.expires < Date.now()) return false;
  if (entry.kind !== kind) return false;
  if (entry.userId !== null && entry.userId !== userId) return false;
  return true;
}

export const pendingChallengeCount = () => pending.size;

/**
 * rpID and origin, derived from the request rather than hardcoded: the app runs
 * on localhost, on the sandbox preview host and eventually on the shop's own
 * domain, and WebAuthn binds credentials to the rpID they were created under.
 */
export function rpContext(req: Request): { rpID: string; origin: string } {
  const host = (req.headers.get("host") ?? "localhost").split(",")[0].trim();
  const hostname = host.replace(/:\d+$/, "");
  const originHeader = req.headers.get("origin");
  const origin = originHeader && /^https?:\/\//.test(originHeader) ? originHeader.replace(/\/$/, "") : `https://${host}`;
  // WebAuthn requires a secure context; localhost is the only http exception.
  if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
    throw Object.assign(new Error("Passkeys need a secure (https) origin."), { status: 400 });
  }
  return { rpID: hostname, origin };
}

// ------------------------------------------------------------- registration --

export async function beginRegistration(user: Profile, req: Request) {
  const { rpID, origin } = rpContext(req);
  const existing = await db().listPasskeys(user.id, false);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    // Stop the same authenticator being enrolled twice.
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
      authenticatorAttachment: "platform",
    },
    attestationType: "none",
  });
  putChallenge("registration", options.challenge, user.id);
  return { options, rpID, origin };
}

export async function completeRegistration(
  user: Profile,
  req: Request,
  response: unknown,
  name?: string,
) {
  const { rpID, origin } = rpContext(req);
  const verified = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge: (challenge) => takeChallenge(challenge, "registration", user.id),
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verified.verified || !verified.registrationInfo) {
    throw Object.assign(new Error("That passkey could not be verified."), { status: 400 });
  }
  const info = verified.registrationInfo;
  const saved = await db().addPasskey({
    id: info.credential.id,
    user_id: user.id,
    public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports: info.credential.transports ?? [],
    name: name?.trim() || defaultCredentialName(info.credentialDeviceType),
    device_type: info.credentialDeviceType ?? null,
    backed_up: !!info.credentialBackedUp,
  });
  // The public key is never returned to the client.
  return { id: saved.id, name: saved.name, device_type: saved.device_type, created_at: saved.created_at };
}

// ----------------------------------------------------------- authentication --

/**
 * `email` is optional: with a discoverable (resident) credential the browser can
 * present the passkey without the cashier typing anything. When supplied we
 * narrow `allowCredentials` to that user's enrolled keys.
 */
export async function beginAuthentication(req: Request, email?: string) {
  const { rpID, origin } = rpContext(req);
  let allowCredentials: { id: string; transports?: string[] }[] | undefined;
  if (email?.trim()) {
    const users = await db().listUsers();
    const user = users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user) throw Object.assign(new Error("No passkeys registered for that account."), { status: 404 });
    const keys = await db().listPasskeys(user.id, false);
    if (!keys.length) throw Object.assign(new Error("No passkeys registered for that account."), { status: 404 });
    allowCredentials = keys.map((k) => ({ id: k.id, transports: k.transports }));
  }
  const options = await generateAuthenticationOptions({ rpID, allowCredentials, userVerification: "preferred" });
  putChallenge("authentication", options.challenge, null);
  return { options, rpID, origin };
}

export async function completeAuthentication(req: Request, response: { id?: string } & Record<string, unknown>) {
  const { rpID, origin } = rpContext(req);
  const credentialId = String(response?.id ?? "");
  if (!credentialId) throw Object.assign(new Error("Missing credential id."), { status: 400 });

  const stored = await db().findPasskey(credentialId);
  if (!stored) throw Object.assign(new Error("That passkey is not registered."), { status: 401 });
  if (stored.revoked_at) {
    // An admin revoked this device; it must never sign in again.
    throw Object.assign(new Error("That passkey has been revoked by an administrator."), { status: 401 });
  }

  const verified = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge: (challenge) => takeChallenge(challenge, "authentication", null),
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: stored.id,
      publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
      counter: stored.counter,
      transports: stored.transports,
    },
  });
  if (!verified.verified) throw Object.assign(new Error("Passkey verification failed."), { status: 401 });

  const { newCounter } = verified.authenticationInfo;
  // Replay defence: a genuine authenticator's sign count only ever increases.
  if (stored.counter > 0 && newCounter <= stored.counter) {
    throw Object.assign(new Error("Passkey counter did not advance — possible replay."), { status: 401 });
  }

  const at = new Date().toISOString();
  await db().recordPasskeyUse(stored.id, newCounter, at);
  const session = await db().createSession(stored.user_id);
  if (!session) throw Object.assign(new Error("Account no longer exists."), { status: 401 });
  return { session, credential: { id: stored.id, name: stored.name } };
}

const defaultCredentialName = (deviceType: string | null) =>
  deviceType === "multiDevice" ? "Synced passkey" : "This device";
