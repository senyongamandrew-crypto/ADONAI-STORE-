import "server-only";
import { cookies } from "next/headers";
import { ROLES, ROUTE_GUARDS, type Role } from "@/lib/config";
import { db } from "@/lib/db";
import type { Profile } from "@/lib/db/types";

export const SESSION_COOKIE = "adonai_session";

export async function getCurrentUser(): Promise<Profile | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const session = await db().getSession(token);
    return session?.user ?? null;
  } catch {
    return null;
  }
}

export const can = (user: Profile | null, ...roles: Role[]): boolean =>
  !!user && roles.includes(user.role);

export async function requireRole(...roles: Role[]): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user || !roles.includes(user.role)) {
    const err = new Error("Not authorised for this action.") as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  return user;
}

/** Set the session cookie on a response. One definition so every login path agrees. */
export function attachSession(res: import("next/server").NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

/** Role guard for a route path — used by the admin layout to bounce unauthorised users. */
export function rolesForPath(pathname: string): Role[] {
  const keys = Object.keys(ROUTE_GUARDS).filter((k) => pathname === k || pathname.startsWith(`${k}/`));
  if (!keys.length) return [ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER];
  return keys.sort((a, b) => b.length - a.length).map((k) => ROUTE_GUARDS[k])[0];
}
