import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Remove your own passkey. Note the scope: a non-admin may only ever touch
 * credentials belonging to their own account — the admin endpoints in
 * /api/admin/passkeys are the only way to revoke someone else's.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await getCurrentUser();
    if (!user) return fail("Sign in first.", 401);
    const { id } = await ctx.params;
    const mine = await db().listPasskeys(user.id, true);
    if (!mine.some((k) => k.id === id)) return fail("That passkey is not yours.", 403);
    const revoked = await db().revokePasskey(id, user, false);
    return ok(revoked);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
