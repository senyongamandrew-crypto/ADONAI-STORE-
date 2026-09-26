import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Administrative override: revoke any staff member's passkey.
 *
 * ADMIN only — a manager or cashier hitting this gets 401 before the id is even
 * read. Revocation is a soft delete, and by default it also invalidates that
 * user's existing session cookies, because a passkey is usually revoked when a
 * device is lost and its cookie would otherwise live on for up to 12 hours.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const admin = await requireRole(ROLES.ADMIN);
    const { id } = await ctx.params;
    const { invalidate_sessions = true } = await body<{ invalidate_sessions?: boolean }>(req).catch(() => ({ invalidate_sessions: undefined }));
    const revoked = await db().revokePasskey(id, admin, invalidate_sessions !== false);
    return ok({ ...revoked, sessions_invalidated: invalidate_sessions !== false });
  } catch (e) {
    const err = e as Error & { status?: number };
    // The store throws plain Errors; HTTP semantics belong here, not there.
    if (/not found/i.test(err.message)) return fail(err.message, 404);
    if (/already revoked/i.test(err.message)) return fail(err.message, 409);
    return fail(err.message, err.status ?? 401);
  }
}
