import type { Metadata, Viewport } from "next";
import { STORE } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${STORE.name} · Pre-loved fashion Kampala`,
  description: `${STORE.name} — dual-channel thrift retail: public showroom, WhatsApp ordering and an in-store POS terminal on one inventory.`,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 5 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
