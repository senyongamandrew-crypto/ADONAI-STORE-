import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { ProductInput } from "@/lib/db/store";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const { id } = await ctx.params;
    const current = await db().findProduct(id);
    if (!current) return fail("Product not found.", 404);
    const patch = await body<Partial<ProductInput>>(req);
    const product = await db().upsertProduct({ ...current, ...patch, id: current.id } as ProductInput);
    return ok(product);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const { id } = await ctx.params;
    await db().deleteProduct(id);
    return ok({ id });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
