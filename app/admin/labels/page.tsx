import { db } from "@/lib/db";
import { LabelsSheet } from "@/components/admin/LabelsSheet";

export const dynamic = "force-dynamic";

export default async function LabelsPage() {
  const products = await db().listProducts({ includeInactive: true });
  return <LabelsSheet initial={products} />;
}
