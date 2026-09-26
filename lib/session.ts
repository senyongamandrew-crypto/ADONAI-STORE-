import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Session token codec.
 *
 * Both drivers mint sessions through here, so a passkey sign-in produces
 * exactly the same cookie as a password sign-in — and so `sessions_invalid_before`
 * can bite in either mode. Kept out of the drivers on purpose: session crypto is
 * not a data-access concern.
 *
 * Format: base64url(JSON).base64url(HMAC-SHA256(body, secret)).
 */
const SECRET =
  process.env.SESSION_SECRET || process.env.LOCAL_AUTH_SECRET || "adonai-local-dev-secret";

const hmac = (body: string) => createHash("sha256").update(`${body}.${SECRET}`).digest("base64url");

export type SessionPayload = { sub: string; iat: number; exp: number };

export const SESSION_TTL_MS = 12 * 3600 * 1000;

export function signSession(sub: string): string {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Returns the payload, or null if the signature or expiry fails. Constant-time compare. */
export function verifySession<T extends object = Record<string, never>>(token: string): (T & SessionPayload) | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T & SessionPayload;
    return typeof payload.exp === "number" && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/**
 * A token issued at or before `cutOff` is dead. This is what makes an admin
 * revocation immediate rather than something that expires in up to 12 hours.
 */
export const sessionIsRevoked = (payload: { iat: number }, cutOff: string | null): boolean =>
  !!cutOff && payload.iat <= new Date(cutOff).getTime();
