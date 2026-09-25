import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ user: await getCurrentUser(), mode: db().kind });
}
