import { NextResponse } from "next/server";

export const ok = <T>(data: T, init?: ResponseInit) => NextResponse.json({ ok: true, data }, init);

export const fail = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status });

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}
