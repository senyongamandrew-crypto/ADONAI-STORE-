import { requireRole } from "@/lib/auth";
import { ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { ProductInput } from "@/lib/db/store";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Public catalog read — the showroom never sees inactive rows. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const staff = sp.get("scope") === "admin";
  if (staff) await requireRole(ROLES.ADMIN, ROLES.MANAGER);
  const products = await db().listProducts({
    query: sp.get("q") ?? undefined,
    category: sp.get("category") ?? undefined,
    includeInactive: staff,
    inStockOnly: sp.get("inStock") === "1",
  });
  return ok(products);
}

export async function POST(req: Request) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER);
    const input = await body<ProductInput>(req);
    const product = await db().upsertProduct(input);
    return ok(product, { status: 201 });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
