import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { dataMode } from "@/lib/db";
import { LoginForm } from "@/components/LoginForm";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "cashier" ? "/pos" : "/admin");
  const mode = dataMode();
  return (
    <>
      <TopBar user={null} mode={mode} showCart={false} />
      <main className="mx-auto max-w-[1400px] px-3 py-10 sm:px-5">
        <LoginForm mode={mode} />
      </main>
    </>
  );
}
