import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { HoldBucket } from "@/lib/db/store";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

const BUCKETS: HoldBucket[] = ["on_trial", "in_inspection"];

/**
 * Move units onto the fitting-room rail (trial) or the QC bench (inspection).
 *
 * Advisory by design: `stock` is untouched, so the counter can still ring up a
 * piece that is in either place. Managers and admins only.
 */
export async function POST(req: Request) {
  try {
    const user = await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const { product_id, bucket, count } = await body<{ product_id: string; bucket: HoldBucket; count: number }>(req);
    if (!product_id) return fail("product_id is required.");
    if (!BUCKETS.includes(bucket)) return fail(`bucket must be one of: ${BUCKETS.join(", ")}.`);
    const n = Math.trunc(Number(count));
    if (!Number.isFinite(n) || n < 0) return fail("count must be a whole number >= 0.");
    if (n > 9999) return fail("count is implausibly large.");
    const product = await db().findProduct(product_id);
    if (!product) return fail("Product not found.", 404);
    const updated = await db().setHold(product_id, bucket, n, user);
    return ok(updated);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
