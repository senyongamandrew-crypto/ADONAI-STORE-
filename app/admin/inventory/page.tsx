import { db } from "@/lib/db";
import { InventoryGrid } from "@/components/admin/InventoryGrid";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const products = await db().listProducts({ includeInactive: true });
  return <InventoryGrid initial={products} />;
}
