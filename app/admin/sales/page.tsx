import { db } from "@/lib/db";
import { SalesLedger } from "@/components/admin/SalesLedger";

export const dynamic = "force-dynamic";

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const status = (await searchParams).status ?? "all";
  const [sales, products] = await Promise.all([db().listSales({ limit: 400 }), db().listProducts({})]);
  return <SalesLedger initial={sales} initialStatus={status} products={products} />;
}
