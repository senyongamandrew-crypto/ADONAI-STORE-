import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Manual stock correction from the back office (delivery, damage, count-up). */
export async function POST(req: Request) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const { product_id, delta, reason } = await body<{ product_id: string; delta: number; reason?: string }>(req);
    const n = Math.trunc(Number(delta));
    if (!product_id || !Number.isFinite(n) || n === 0) return fail("product_id and a non-zero delta are required.");
    const product = await db().adjustStock(product_id, n, reason || "Manual adjustment");
    return ok(product);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
