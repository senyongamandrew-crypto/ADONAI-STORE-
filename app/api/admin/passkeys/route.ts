import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Every passkey registration in the shop, newest first. Admins only. */
export async function GET(req: Request) {
  try {
    await requireRole(ROLES.ADMIN);
    const user = new URL(req.url).searchParams.get("user");
    const activeOnly = new URL(req.url).searchParams.get("active") === "1";
    const rows = await db().listPasskeys(user ?? undefined, !activeOnly);
    return ok(rows.map(({ public_key: _publicKey, ...rest }) => rest));
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}
