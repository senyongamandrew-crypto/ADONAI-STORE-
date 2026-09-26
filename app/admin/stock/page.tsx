import { db } from "@/lib/db";
import { StockStages } from "@/components/admin/StockStages";

export const dynamic = "force-dynamic";

/** Trial & Inspection workspace — the /admin layout enforces manager-or-above. */
export default async function StockStagesPage() {
  const products = await db().listProducts({ includeInactive: true });
  return <StockStages initial={products} />;
}
