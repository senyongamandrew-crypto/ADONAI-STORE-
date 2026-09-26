import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ROUTE_GUARDS, type Role } from "@/lib/config";
import { dataMode } from "@/lib/db";
import { TopBar } from "@/components/TopBar";
import { AdminNav } from "@/components/admin/AdminNav";

export const dynamic = "force-dynamic";

/**
 * RBAC gate for the whole back office. Every /admin route requires admin|manager
 * (see ROUTE_GUARDS), so one check here covers the dashboard and all sub-pages;
 * each API route re-checks independently — the UI is never the only guard.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const allowed = ROUTE_GUARDS["/admin"];
  if (!allowed.includes(user.role as Role)) redirect("/pos");

  return (
    <>
      <TopBar user={user} mode={dataMode()} showCart={false} />
      <div className="mx-auto max-w-[1400px] px-3 py-4 sm:px-5">
        <AdminNav role={user.role as Role} />
        {children}
      </div>
    </>
  );
}
