import { onStock } from "@/lib/events";
import { db } from "@/lib/db";
import { supabaseConfigured } from "@/lib/supabase/env";
import type { StockEvent } from "@/lib/stockEvent";

export const dynamic = "force-dynamic";

/**
 * Server-sent events for stock changes.
 *
 * Two sources, deliberately non-overlapping:
 *  - the in-process bus, which every write in this Node process publishes to
 *    (both drivers — this is what makes the local demo push in real time);
 *  - Supabase Realtime, when configured, which also catches writes made by
 *    other processes or directly against the database.
 *
 * The public catalog and every open POS terminal listen here, so an item sold at
 * the counter flips to "Sold out" on the website without a reload.
 */
export async function GET() {
  const encoder = new TextEncoder();
  // Declared before the stream: `start` runs synchronously during construction,
  // so assigning to it from inside would otherwise hit the TDZ.
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("hello", { mode: db().kind, at: new Date().toISOString() });

      // 1. same-process writes
      const offBus = onStock((event: StockEvent) => send("stock", event));

      // 2. database-level changes (Supabase mode only)
      let unsubscribeRealtime: (() => void) | null = null;
      if (supabaseConfigured()) {
        // Imported lazily: pulling the service client in unconditionally would
        // throw in local mode, where no Supabase credentials exist.
        const { supabaseAdmin } = require("@/lib/supabase/server") as typeof import("@/lib/supabase/server");
        const channel = supabaseAdmin()
          .channel("stock-stream")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "products" },
            (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
              const row = (payload.new ?? payload.old) as { id?: string; sku?: string; stock?: number } | undefined;
              if (!row?.id) return;
              send("stock", {
                product_id: row.id,
                sku: row.sku ?? "",
                stock: Number(row.stock ?? 0),
                reason: "database",
                at: new Date().toISOString(),
              });
            },
          )
          .subscribe();
        unsubscribeRealtime = () => supabaseAdmin().removeChannel(channel);
      }

      // Keeps proxies from closing an idle connection.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 25_000);

      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        offBus();
        unsubscribeRealtime?.();
      };
    },

    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx/preview proxies buffer by default, which would batch the events.
      "x-accel-buffering": "no",
    },
  });
}
