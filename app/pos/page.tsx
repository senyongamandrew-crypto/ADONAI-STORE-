import { redirect } from "next/navigation";
import { getCurrentUser, rolesForPath } from "@/lib/auth";
import { dataMode, db } from "@/lib/db";
import { PosTerminal } from "@/components/PosTerminal";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function PosPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!rolesForPath("/pos").includes(user.role)) redirect("/login");
  const products = await db().listProducts({});
  return (
    <>
      <TopBar user={user} mode={dataMode()} showCart={false} />
      <PosTerminal initial={{ products, user }} />
    </>
  );
}
