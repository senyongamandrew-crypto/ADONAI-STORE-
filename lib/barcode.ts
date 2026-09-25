/**
 * Integrated Barcode Generator.
 * Code 128 for retail hang-tags and QR for social handoff, rendered server-side to SVG
 * (bwip-js node build) so printed labels, receipts and the labels sheet all match.
 */
import bwipjs from "bwip-js/node";

export type BarcodeKind = "code128" | "qrcode";

export async function renderBarcodeSvg(
  value: string,
  kind: BarcodeKind = "code128",
  opts: { width?: number; height?: number; includeText?: boolean } = {},
): Promise<string> {
  // bwip-js rejects options whose value is undefined, so only pass what is set.
  const options: Record<string, string | number | boolean> = {
    bcid: kind,
    text: value,
    scale: 3,
    height: opts.height ?? (kind === "code128" ? 12 : 18),
    includetext: opts.includeText ?? kind === "code128",
    textxalign: "center",
    textsize: 10,
    backgroundcolor: "FFFFFF",
    padding: 6,
  };
  if (opts.width) options.width = opts.width;

  return bwipjs.toSVG(options as never);
}

/** EAN-13 numeric barcode for scanner hardware: 12 hash-derived digits + check digit. */
export function generateBarcode(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1_000_000_007;
  const base = String(Math.abs(h)).padStart(12, "0").slice(-12);
  const sum = base.split("").reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}
