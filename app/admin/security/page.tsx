import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ROUTE_GUARDS, type Role } from "@/lib/config";
import { SecurityPanel } from "@/components/admin/SecurityPanel";

export const dynamic = "force-dynamic";

/**
 * Admin-only page. The layout already gates /admin to admin|manager; this
 * tightens it further, and every endpoint below re-checks the role itself.
 */
export default async function SecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!ROUTE_GUARDS["/admin/security"].includes(user.role as Role)) redirect("/admin");
  return <SecurityPanel me={user} />;
}
