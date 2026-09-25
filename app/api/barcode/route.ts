import { NextResponse } from "next/server";
import { renderBarcodeSvg } from "@/lib/barcode";

export const dynamic = "force-dynamic";

/** /api/barcode?value=AD-001&kind=code128&includeText=1 → printable SVG hang-tag. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const value = sp.get("value");
  if (!value) return new NextResponse("value is required", { status: 400 });
  const kind = sp.get("kind") === "qrcode" ? "qrcode" : "code128";
  const svg = await renderBarcodeSvg(value, kind, { includeText: sp.get("includeText") !== "0" });
  return new NextResponse(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
  });
}
