import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { body, fail, ok } from "@/lib/http";
import { completeRegistration } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/** Step 2: verify the authenticator's attestation and store its public key. */
export async function POST(req: Request) {
  try {
    const user = await requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER);
    const { credential, name } = await body<{ credential: unknown; name?: string }>(req);
    if (!credential) return fail("A credential response is required.");
    const saved = await completeRegistration(user, req, credential, name);
    return ok(saved);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
