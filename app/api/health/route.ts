import { db } from "@/lib/db";
import { ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Ops probe: reports which driver is live and how many rows it holds. */
export async function GET() {
  const store = db();
  const [products, sales] = await Promise.all([store.listProducts({ includeInactive: true }), store.listSales({ limit: 5000 })]);
  return ok({
    mode: store.kind,
    products: products.length,
    sales: sales.length,
    inStock: products.filter((p) => p.stock > 0).length,
    time: new Date().toISOString(),
  });
}
