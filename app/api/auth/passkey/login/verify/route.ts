import { attachSession } from "@/lib/auth";
import { body, fail, ok } from "@/lib/http";
import { completeAuthentication } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/**
 * Anonymous: completes a passkey sign-in and sets the same cookie the password
 * flow sets, so the rest of the app cannot tell the two apart.
 */
export async function POST(req: Request) {
  try {
    const payload = await body<{ credential: { id?: string } & Record<string, unknown> }>(req);
    if (!payload?.credential) return fail("A credential response is required.");
    const { session, credential } = await completeAuthentication(req, payload.credential);
    if (!session.token) return fail("Could not start a session.", 500);
    return attachSession(ok({ ...session.user, via: "passkey", passkey: credential.name }), session.token);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}
