import "server-only";
import { supabaseConfigured } from "@/lib/supabase/env";
import { localStore } from "@/lib/db/local";
import type { Store } from "@/lib/db/store";

let cached: Store | null = null;

/**
 * Driver selector. With Supabase env vars present the app runs against Postgres
 * (schema in /supabase/schema.sql); without them it falls back to the local
 * file store in .data/adonai.json so the system is demoable with zero setup.
 */
export function db(): Store {
  if (cached) return cached;
  if (supabaseConfigured()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require("@/lib/supabase/driver").supabaseStore as Store;
  } else {
    cached = localStore;
  }
  return cached;
}

export const dataMode = (): Store["kind"] => db().kind;
export type { Store } from "@/lib/db/store";
