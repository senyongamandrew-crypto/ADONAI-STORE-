import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { SaleStatus } from "@/lib/db/types";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Approve / cancel / refund — stock moves inside the same transaction. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const { id } = await ctx.params;
    const { status } = await body<{ status: SaleStatus }>(req);
    if (!["completed", "pending", "cancelled", "refunded"].includes(status)) return fail("Unknown status.");
    const sale = await db().setSaleStatus(id, status);
    return ok(sale);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
