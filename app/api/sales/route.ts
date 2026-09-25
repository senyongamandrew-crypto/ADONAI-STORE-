import { requireRole } from "@/lib/auth";
import { CHANNELS, ROLES } from "@/lib/config";
import { db } from "@/lib/db";
import type { CreateSaleInput } from "@/lib/db/store";
import { body, fail, ok } from "@/lib/http";
import { clientKey, rateLimit, sweep } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const MAX_LINES = 25;
const MAX_QTY_ONLINE = 20;
const MAX_QTY_POS = 500;

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

const shapeLines = (lines: CreateSaleInput["lines"], maxQty: number) => {
  if (!Array.isArray(lines) || lines.length === 0) return "Add at least one item.";
  if (lines.length > MAX_LINES) return `An order cannot exceed ${MAX_LINES} lines.`;
  for (const l of lines) {
    if (!l?.product_id) return "Every line needs a product_id.";
    const qty = Math.trunc(Number(l.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > maxQty) return `Quantity must be between 1 and ${maxQty}.`;
  }
  return null;
};

/**
 * Two callers, two trust levels:
 *  - channel=pos     — signed-in cashier; settles immediately and decrements stock.
 *  - channel=online  — anonymous shopper; validated, rate-limited, and always
 *                      recorded as `pending` so stock only moves when a manager
 *                      approves the order in the back office.
 */
export async function POST(req: Request) {
  try {
    const input = await body<CreateSaleInput>(req);
    const channel = input.channel === "online" ? "online" : "pos";

    if (channel === "pos") {
      const actor = await requireRole(ROLES.ADMIN, ROLES.MANAGER, ROLES.CASHIER);
      const problem = shapeLines(input.lines, MAX_QTY_POS);
      if (problem) return fail(problem);
      const sale = await db().createSale(
        { ...input, channel, status: input.status ?? "completed" },
        actor,
      );
      return ok(sale, { status: 201 });
    }

    // ---- anonymous online order -------------------------------------------
    const name = (input.customer_name ?? "").trim();
    const phone = (input.customer_phone ?? "").replace(/\s+/g, "");
    if (name.length < 2) return fail("Please add a name so the shop knows who to confirm with.");
    if (!/^\+?\d{9,15}$/.test(phone)) return fail("Add a reachable phone number, e.g. +2567XXXXXXXX.");

    const problem = shapeLines(input.lines, MAX_QTY_ONLINE);
    if (problem) return fail(problem);

    // Trusted-proxy client IP. Behind a proxy this is the real caller; if this
    // app is ever exposed directly it can be spoofed, so treat it as a speed
    // bump rather than a security boundary.
    sweep();
    const limit = rateLimit(`order:${clientKey(req)}`, 10, 10 * 60 * 1000);
    if (!limit.ok) {
      return fail(`Too many orders from this connection. Try again in ${Math.ceil(limit.retryAfterMs / 60000)} minute(s).`, 429);
    }

    const sale = await db().createSale(
      {
        channel: "online",
        status: "pending", // never trusted from the client
        tender: null,
        amount_received: 0,
        discount_total: 0,
        customer_name: name,
        customer_phone: phone,
        note: (input.note ?? "").slice(0, 280) || null,
        lines: input.lines,
      },
      null,
    );
    return ok(sale, { status: 201 });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
