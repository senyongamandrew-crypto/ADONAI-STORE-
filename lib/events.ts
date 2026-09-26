import "server-only";
import type { StockEvent } from "@/lib/stockEvent";

/**
 * In-process stock bus.
 *
 * Covers every write handled by this Node process in either driver — a counter
 * sale, an approved online order, a manual adjustment. Cross-process and
 * direct-to-database writes in Supabase mode are picked up separately by the
 * Realtime subscription in app/api/stream/route.ts, so the two never overlap:
 * the Supabase driver deliberately does not publish here.
 */
type Listener = (event: StockEvent) => void;

const listeners = new Set<Listener>();

export function publishStock(event: Omit<StockEvent, "at">): void {
  const full: StockEvent = { ...event, at: new Date().toISOString() };
  for (const listener of listeners) {
    try {
      listener(full);
    } catch {
      // A dead SSE controller must never break the transaction that emitted.
    }
  }
}

/** Subscribe; returns the unsubscribe function. */
export function onStock(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const stockListenerCount = (): number => listeners.size;
