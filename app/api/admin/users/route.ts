import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Staff directory with passkey counts. Admins only. */
export async function GET() {
  try {
    await requireRole(ROLES.ADMIN);
    return ok(await db().listUsers());
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}
