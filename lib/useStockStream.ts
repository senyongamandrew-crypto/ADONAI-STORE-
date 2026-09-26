"use client";
import { useEffect, useRef, useState } from "react";
import { isStockEvent, type StockEvent } from "@/lib/stockEvent";

export type StreamStatus = "connecting" | "live" | "offline";

/**
 * Subscribes the page to /api/stream (SSE).
 *
 * EventSource reconnects on its own, so a dropped connection recovers without
 * user action; callers should still keep a slow background refetch as a
 * backstop for the gap between disconnect and reconnect.
 */
export function useStockStream(onStock: (event: StockEvent) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const handler = useRef(onStock);
  handler.current = onStock;

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setStatus("offline");
      return;
    }

    const source = new EventSource("/api/stream");

    const onEvent = (raw: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(raw.data);
        if (isStockEvent(parsed)) handler.current(parsed);
      } catch {
        /* ignore malformed frames */
      }
    };

    source.addEventListener("hello", () => setStatus("live"));
    source.addEventListener("stock", onEvent);
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus(source.readyState === EventSource.CONNECTING ? "connecting" : "offline");

    return () => {
      source.removeEventListener("stock", onEvent);
      source.close();
    };
  }, []);

  return status;
}
