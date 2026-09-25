import { SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { email, password } = await body<{ email: string; password: string }>(req);
  if (!email || !password) return fail("Email and password are required.");
  const session = await db().signIn(email, password);
  if (!session?.token) return fail("Invalid email or password.", 401);
  const res = ok(session.user);
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
