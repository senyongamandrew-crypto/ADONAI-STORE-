/**
 * Wipes the local demo store (.data/adonai.json). The next request reseeds
 * 24 demo products + ~3 weeks of mixed POS/online sales.
 */
import { rmSync, existsSync } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), ".data", "adonai.json");
if (existsSync(file)) {
  rmSync(file);
  console.log(`removed ${file} — the local driver will reseed on next request`);
} else {
  console.log(`${file} does not exist; nothing to reset`);
}
