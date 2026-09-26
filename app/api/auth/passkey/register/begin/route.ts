import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { fail, ok } from "@/lib/http";
import { beginRegistration } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/** Step 1 of enrolling a passkey: the caller must already be signed in. */
export async function POST(req: Request) {
  try {
    const user = await requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER);
    const { options, rpID } = await beginRegistration(user, req);
    return ok({ options, rpID });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
