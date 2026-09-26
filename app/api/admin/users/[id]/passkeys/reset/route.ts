import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The reset flow: revoke every passkey a user holds in one action, so they must
 * re-enrol on the devices they still have. Password sign-in is untouched, so
 * nobody is locked out of the shop by this.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const admin = await requireRole(ROLES.ADMIN);
    const { id } = await ctx.params;
    const users = await db().listUsers();
    if (!users.some((u) => u.id === id)) return fail("No such staff member.", 404);
    const { invalidate_sessions = true } = await body<{ invalidate_sessions?: boolean }>(req).catch(() => ({ invalidate_sessions: undefined }));
    const revoked = await db().revokeAllPasskeys(id, admin, invalidate_sessions !== false);
    return ok({ user_id: id, revoked, sessions_invalidated: invalidate_sessions !== false });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}
