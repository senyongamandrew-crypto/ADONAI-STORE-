/**
 * Static contract check between lib/supabase/driver.ts and the REAL database.
 *
 * The Supabase driver cannot be executed here (no Supabase project, and standing
 * up a fake PostgREST would only prove that my fake agrees with my driver). So
 * this does the next most useful thing: it boots the same ephemeral Postgres as
 * verify-sql.mjs, applies supabase/schema.sql, then asserts that every table,
 * column, RPC and payload key the driver names actually exists in the live
 * catalog. A renamed column or a typo'd RPC fails here rather than in production.
 *
 *   npm i -D embedded-postgres      # one-off, not a runtime dependency
 *   npm run verify:driver
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let EmbeddedPostgres, pg;
try {
  EmbeddedPostgres = (await import("embedded-postgres")).default;
  pg = (await import("pg")).default;
} catch {
  console.log("\nskipped: `npm i -D embedded-postgres` to run the driver contract check.\n");
  process.exit(0);
}

const root = process.cwd();
const schema = readFileSync(path.join(root, "supabase", "schema.sql"), "utf8");
const driver = readFileSync(path.join(root, "lib", "supabase", "driver.ts"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  cond ? (pass++, console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`)) : (fail++, failures.push(name), console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`));
};

// ------------------------------------------------------------ parse the driver
const tables = [...new Set([...driver.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))];
const rpcs = [...new Set([...driver.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]))];

/** Columns the driver names in filters, ordering and upsert payloads. */
const referencedColumns = new Map(); // table -> Set<column>
const noteColumn = (table, col) => {
  if (!col || !/^[a-z_]+$/.test(col)) return;
  if (!referencedColumns.has(table)) referencedColumns.set(table, new Set());
  referencedColumns.get(table).add(col);
};

// .from("t") ... .eq/.gt/.gte/.lt/.lte/.in/.neq("col", ...) / .order("col") / .select("col")
const chained = driver.split(/\.from\("([a-z_]+)"\)/);
for (let i = 1; i < chained.length; i += 2) {
  const table = chained[i];
  const segment = chained[i + 1] ?? "";
  for (const m of segment.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|in|order)\("([a-z_]+)"/g)) noteColumn(table, m[1]);
  for (const m of segment.matchAll(/\.select\("\*"?\)|\.select\("([^"]+)"\)/g)) {
    if (m[1]) for (const c of m[1].split(",")) noteColumn(table, c.trim());
  }
  for (const m of segment.matchAll(/\.or\(`([^`]+)`\)/g)) {
    for (const part of m[1].split(",")) noteColumn(table, part.split(".")[0].trim());
  }
  // row mappers and inline maps read columns as r.<col> — a rename breaks these
  for (const m of segment.matchAll(/\br\.([a-z_]+)/g)) noteColumn(table, m[1]);

  // upsert row objects: read the keys of the nearest `const row = { ... }` block
  if (/\.upsert\(/.test(segment)) {
    const rowMatch = chained[i - 1]?.match(/const row = \{([\s\S]*?)\n    \};/);
    if (rowMatch) for (const m of rowMatch[1].matchAll(/^\s{6}([a-z_]+):/gm)) noteColumn(table, m[1]);
  }
}

/**
 * Row mappers are declared at module scope, outside any .from() chain, so bind
 * them to their table by hand and collect every r.<column> they read. This is
 * where a renamed column would actually break at runtime.
 */
const MAPPERS = { toProduct: "products", toSale: "sales", toLine: "sale_lines" };
for (const [fn, table] of Object.entries(MAPPERS)) {
  const at = driver.indexOf(`const ${fn} = `);
  if (at === -1) continue;
  // The mapper is an arrow function returning an object literal, so it ends at
  // the first of "\n});" or "\n};" — taking only one of them overruns the body.
  const ends = ["\n});", "\n};"].map((t) => driver.indexOf(t, at)).filter((i) => i !== -1);
  if (!ends.length) continue;
  const body = driver.slice(at, Math.min(...ends));
  for (const m of body.matchAll(/\br\.([a-z_]+)/g)) noteColumn(table, m[1]);
}

/**
 * Top-level keys of the object literal whose `{` sits at `open`.
 * Handles one-line and multi-line literals, `key: value`, shorthand `key,`
 * and arbitrarily nested braces/brackets/parens.
 */
function topLevelKeys(src, open) {
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return new Set();

  const entries = [];
  let d = 0;
  let cur = "";
  for (const ch of src.slice(open + 1, end)) {
    if (ch === "{" || ch === "[" || ch === "(") d++;
    if (ch === "}" || ch === "]" || ch === ")") d--;
    if (ch === "," && d === 0) {
      entries.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) entries.push(cur);

  const keys = new Set();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e || e.startsWith("...")) continue;
    const keyed = e.match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (keyed) { keys.add(keyed[1]); continue; }
    const shorthand = e.match(/^([A-Za-z_$][\w$]*)$/);
    if (shorthand) keys.add(shorthand[1]);
  }
  return keys;
}

const objectAfter = (needle) => {
  const at = driver.indexOf(needle);
  if (at === -1) return new Set();
  const brace = driver.indexOf("{", at + needle.length - 1);
  return brace === -1 ? new Set() : topLevelKeys(driver, brace);
};

/** RPC argument names actually passed at the top level, e.g. { payload, actor }. */
const rpcArgs = new Map();
for (const m of driver.matchAll(/\.rpc\("([a-z_]+)",\s*\{/g)) {
  rpcArgs.set(m[1], objectAfter(m[0].slice(0, m[0].length - 1)));
}

/** Keys the driver puts in the finalize_sale payload. */
const payloadKeys = objectAfter("const payload = {");
const schemaPayloadKeys = new Set([...schema.matchAll(/payload->>?'([a-z_]+)'/g)].map((m) => m[1]));

// ------------------------------------------------------------------ live catalog
const PORT = 55442;
const server = new EmbeddedPostgres({ databaseDir: path.join(root, ".data", "pg-contract"), user: "postgres", password: "postgres", port: PORT, persistent: false });
console.log("\nstarting ephemeral Postgres…");
await server.initialise();
await server.start();
await server.createDatabase("adonai");
const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: "postgres", database: "adonai" });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;

try {
  await q(`
    create schema if not exists auth;
    create table auth.users (instance_id uuid, id uuid primary key default gen_random_uuid(), aud text, role text,
      email text unique, encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb,
      raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;
  `);
  await q(schema);

  const catalogTables = new Set((await q("select table_name from information_schema.tables where table_schema = 'public'")).map((r) => r.table_name));
  const columnsOf = async (t) => new Set((await q("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [t])).map((r) => r.column_name));
  const functions = await q(`
    select p.proname as name, coalesce(array_agg(pa.pg_get_function_identity_arguments), '{}') as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join lateral (select pg_get_function_identity_arguments(p.oid) as pg_get_function_identity_arguments) pa on true
    where n.nspname = 'public' group by p.proname, p.oid`);
  const paramsOf = async (fn) =>
    (await q("select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [fn]))[0]?.args ?? "";

  console.log(`driver references ${tables.length} tables, ${rpcs.length} RPCs\n`);

  check("driver references at least the core tables", ["products", "sales", "sale_lines", "stock_movements", "profiles"].every((t) => tables.includes(t)), tables.join(", "));

  for (const t of tables) {
    check(`table "${t}" exists in the catalog`, catalogTables.has(t));
    if (!catalogTables.has(t)) continue;
    const cols = await columnsOf(t);
    const wanted = referencedColumns.get(t) ?? new Set();
    const missing = [...wanted].filter((c) => !cols.has(c));
    check(`every "${t}" column the driver names exists`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${wanted.size} columns checked`);
  }

  for (const fn of rpcs) {
    const exists = functions.some((f) => f.name === fn);
    check(`RPC "${fn}" exists`, exists);
    if (!exists) continue;
    const declared = await paramsOf(fn);
    const wanted = rpcArgs.get(fn) ?? new Set();
    check(`parsed at least one argument for RPC "${fn}"`, wanted.size > 0, [...wanted].join(", ") || "parser found nothing — check would be vacuous");
    const missing = [...wanted].filter((a) => !declared.includes(a));
    check(`RPC "${fn}" declares the arguments the driver passes`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")} (declared: ${declared})` : `${wanted.size} args`);
  }

  check("parsed the finalize_sale payload keys", payloadKeys.size > 0, [...payloadKeys].join(", ") || "parser found nothing");
  const unknownPayload = [...payloadKeys].filter((k) => !schemaPayloadKeys.has(k));
  check(
    "every finalize_sale payload key the driver sends is read by the SQL",
    unknownPayload.length === 0,
    unknownPayload.length ? `unread: ${unknownPayload.join(", ")}` : `${payloadKeys.size} keys`,
  );
  check("the SQL reads at least the lines and channel keys", schemaPayloadKeys.has("lines") && schemaPayloadKeys.has("channel"));
} finally {
  await client.end();
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed${fail ? ` → ${failures.join("; ")}` : ""}\n`);
process.exit(fail ? 1 : 0);
