import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The signed-in user's own passkeys (public material only). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Sign in first.", 401);
  return ok(await db().listPasskeys(user.id, true));
}
