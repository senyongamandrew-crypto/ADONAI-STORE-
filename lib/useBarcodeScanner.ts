"use client";
import { useEffect, useRef } from "react";

/**
 * Focused Barcode Keystroke Listener.
 * USB/Bluetooth scanners act as keyboards and emit the payload as a fast burst of
 * keystrokes ending in Enter. We buffer on keydown, and only treat it as a scan when
 * the whole string arrives within SCAN_WINDOW_MS and is longer than MIN_LEN —
 * which keeps ordinary typing out of the scan path.
 */
export function useBarcodeScanner(onScan: (code: string) => void, opts: { enabled?: boolean; minLength?: number; windowMs?: number } = {}) {
  const { enabled = true, minLength = 4, windowMs = 60 } = opts;
  const buffer = useRef("");
  const lastKey = useRef(0);
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !target.dataset.scanner) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const now = Date.now();
      if (now - lastKey.current > windowMs) buffer.current = "";
      lastKey.current = now;

      if (e.key === "Enter") {
        const code = buffer.current.trim();
        buffer.current = "";
        if (code.length >= minLength) {
          e.preventDefault();
          handler.current(code);
        }
        return;
      }
      if (e.key.length === 1) buffer.current += e.key;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, minLength, windowMs]);
}
