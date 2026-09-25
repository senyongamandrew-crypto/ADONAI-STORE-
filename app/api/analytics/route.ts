import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 30) || 30, 1), 365);
    return ok(await db().analytics(days));
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}
