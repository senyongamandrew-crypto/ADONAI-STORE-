/** Deterministic SVG placeholders so the catalog renders with zero external assets. */
const PALETTE = [
  ["#e8dcc8", "#7a5c3e"],
  ["#d9e4dd", "#3f6052"],
  ["#e6d8e0", "#6d4360"],
  ["#dfe1ea", "#3f476b"],
  ["#f0dfd0", "#8a5a34"],
  ["#dde6ea", "#35586a"],
];

export function placeholderImage(seed: string, label = "AD"): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  const [bg, fg] = PALETTE[h % PALETTE.length];
  const initials = label.replace(/[^A-Za-z ]/g, "").split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase() || "AD";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <rect width="400" height="400" fill="${bg}"/>
  <circle cx="200" cy="176" r="86" fill="${fg}" opacity="0.14"/>
  <text x="200" y="205" font-family="Georgia,serif" font-size="86" fill="${fg}" text-anchor="middle" opacity="0.85">${initials}</text>
  <text x="200" y="268" font-family="ui-monospace,monospace" font-size="18" fill="${fg}" text-anchor="middle" opacity="0.6">ADONAI THRIFT</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
