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
      <head>
        {/* Soft boutique serif + rounded grotesque. Loaded from the CDN at runtime;
            the stacks in tailwind.config.ts fall back to Georgia / system sans when
            it is unreachable. Fraunces' `opsz` axis is what keeps the display sizes
            warm rather than brittle. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Outfit:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
