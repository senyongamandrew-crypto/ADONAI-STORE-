import { requireRole } from "@/lib/auth";
import { CHANNELS, ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { CreateSaleInput } from "@/lib/db/store";
import { body, fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER);
    const sp = new URL(req.url).searchParams;
    const channel = sp.get("channel");
    const sales = await db().listSales({
      channel: channel && (CHANNELS as readonly string[]).includes(channel) ? (channel as "pos" | "online") : undefined,
      status: (sp.get("status") as CreateSaleInput["status"]) ?? undefined,
      limit: Number(sp.get("limit") ?? 200) || 200,
    });
    return ok(sales);
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 401);
  }
}

/**
 * Multi-tender settlement (channel=pos, requires a signed-in cashier) and
 * online order capture (channel=online, anonymous → recorded as `pending`
 * so stock only moves when a manager approves it).
 */
export async function POST(req: Request) {
  try {
    const input = await body<CreateSaleInput>(req);
    const channel = input.channel === "online" ? "online" : "pos";
    let actor = null;
    if (channel === "pos") actor = await requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER);
    const sale = await db().createSale({ ...input, channel }, actor);
    return ok(sale, { status: 201 });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
