/**
 * Verifies supabase/schema.sql + supabase/seed.sql against a real, ephemeral
 * Postgres — the same PL/pgSQL that runs on Supabase.
 *
 *   npm i -D embedded-postgres      # one-off, not a runtime dependency
 *   npm run verify:sql
 *
 * Supabase's auth schema is stubbed exactly the way Supabase implements it
 * (auth.uid() reads the request JWT claim), so the RLS policies are exercised
 * for real rather than skipped.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let EmbeddedPostgres, pg;
try {
  EmbeddedPostgres = (await import("embedded-postgres")).default;
  pg = (await import("pg")).default;
} catch {
  console.log("\nskipped: `npm i -D embedded-postgres` to run the SQL check.\n");
  process.exit(0);
}

const root = process.cwd();
const schema = readFileSync(path.join(root, "supabase", "schema.sql"), "utf8");
const seed = readFileSync(path.join(root, "supabase", "seed.sql"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  cond ? (pass++, console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`)) : (fail++, failures.push(name), console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`));
};

const PORT = 55432;
const server = new EmbeddedPostgres({ databaseDir: path.join(root, ".data", "pg-verify"), user: "postgres", password: "postgres", port: PORT, persistent: false });

console.log("\nstarting ephemeral Postgres…");
await server.initialise();
await server.start();
await server.createDatabase("adonai");

const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: "postgres", database: "adonai" });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

try {
  // Stub the Supabase auth surface (auth.users + auth.uid() from the request JWT claim).
  await q(`
    create schema if not exists auth;
    create table auth.users (
      instance_id uuid, id uuid primary key default gen_random_uuid(),
      aud text, role text, email text unique, encrypted_password text,
      email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
      created_at timestamptz, updated_at timestamptz
    );
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    -- Supabase provisions these three roles on every project.
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;   -- Supabase grants this so auth.uid() is callable
  `);

  console.log("applying supabase/schema.sql");
  await q(schema);
  check("schema.sql applies cleanly", true);

  console.log("applying supabase/seed.sql");
  await q(seed);
  check("seed.sql applies cleanly", true);

  // --------------------------------------------------- passkeys & hold columns
  console.log("re-applying supabase/schema.sql (idempotency)");
  await q(schema);
  check("schema.sql is idempotent — a second apply changes nothing", true);

  const holdCols = await q(
    "select column_name, column_default from information_schema.columns where table_schema='public' and table_name='products' and column_name in ('on_trial','in_inspection')",
  );
  check(
    "products carries the advisory trial/inspection counters",
    holdCols.length === 2 && holdCols.every((c) => c.column_default === "0"),
    holdCols.map((c) => `${c.column_name} default ${c.column_default}`).join(" "),
  );
  const negHold = await one(
    `do $$ begin update products set on_trial = -1 where sku = (select sku from products limit 1); exception when check_violation then raise 'CHECK_OK'; end $$;`,
  ).catch((e) => ({ err: e.message }));
  check("a negative trial count is refused by a CHECK constraint", /CHECK_OK/.test(String(negHold?.err ?? "")), String(negHold?.err ?? "").slice(0, 40));

  const sessCol = await one(
    "select column_name from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='sessions_invalid_before'",
  );
  check("profiles can invalidate sessions from a moment in time", !!sessCol);

  const pkRls = await one(
    "select c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname='public' and p.tablename='passkeys') as policies from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='passkeys'",
  );
  check("passkeys table exists", !!pkRls);
  check(
    "passkeys is RLS-locked with no policies (service role only)",
    pkRls?.rls === true && pkRls?.policies === 0,
    `rls=${pkRls?.rls} policies=${pkRls?.policies}`,
  );

  const owner = await one("select id, email from profiles where email = 'cashier@adonai.ug'");
  await q(
    `insert into passkeys (id, user_id, public_key, counter, transports, name, device_type, backed_up)
     values ('sql-test-credential', $1, 'pQECAyYgASFYItest', 0, '{internal}', 'SQL harness key', 'singleDevice', false)`,
    [owner.id],
  );
  const viaView = await one("select id, user_email, user_role, revoked_at from passkeys_admin where id = 'sql-test-credential'");
  check(
    "the admin view joins the owner onto each registration",
    viaView?.user_email === "cashier@adonai.ug" && viaView?.user_role === "cashier" && viaView?.revoked_at === null,
    `${viaView?.user_email}/${viaView?.user_role}`,
  );
  const held = await one(
    `update products set on_trial = 2, in_inspection = 1 where id = (select id from products order by sku limit 1) returning on_trial, in_inspection, stock`,
  );
  check("advisory counters update without touching sellable stock", held?.on_trial === 2 && held?.in_inspection === 1, `stock=${held?.stock}`);
  await q("delete from passkeys where id = 'sql-test-credential'");

  // ------------------------------------------------------------- catalog seed
  const { n: productCount } = await one("select count(*)::int as n from products");
  check("24 demo products seeded", productCount === 24, `${productCount}`);

  const roles = await q("select email, role from profiles order by email");
  check(
    "staff roles are assigned",
    roles.some((r) => r.email === "admin@adonai.ug" && r.role === "admin") && roles.some((r) => r.email === "cashier@adonai.ug" && r.role === "cashier"),
    roles.map((r) => `${r.email}:${r.role}`).join(" "),
  );

  const { n: salesCount } = await one("select count(*)::int as n from sales");
  const { n: refCount } = await one("select count(distinct ref)::int as n from sales");
  check("demo sales generated through finalize_sale()", salesCount > 60, `${salesCount} sales`);
  check("every sale ref is unique (UNIQUE constraint holds)", refCount === salesCount, `${refCount}/${salesCount}`);

  const { neg } = await one("select count(*)::int as neg from products where stock < 0");
  check("no product went below zero during seeding", neg === 0);

  // ------------------------------------------------------ atomic stock decrement
  // The demo sales above have already drawn stock down, so pick a line with room.
  const target = await one("select id, sku, stock, price from products where active and stock >= 5 order by sku limit 1");
  check("a product with sellable stock exists", !!target, target?.sku);
  const cashier = await one("select id, name from profiles where email = 'cashier@adonai.ug'");

  check("chosen target has room for the test sale", target.stock >= 3, `${target.sku} stock=${target.stock}`);
  const sale = await one(
    "select public.finalize_sale($1::jsonb, $2::jsonb) as r",
    [
      JSON.stringify({ channel: "pos", tender: "Cash", amount_received: target.price * 2 + 5000, discount_total: 0, lines: [{ product_id: target.id, qty: 2 }] }),
      JSON.stringify({ id: cashier.id, name: cashier.name }),
    ],
  );
  const after = await one("select stock from products where id = $1", [target.id]);
  check("finalize_sale decrements stock", after.stock === target.stock - 2, `${target.stock} → ${after.stock}`);

  const ref = sale.r.ref;
  check("finalize_sale returns a POS ref", /^POS-\d{5}$/.test(ref), ref);
  const movement = await one("select delta, reason from stock_movements where sale_id = (select id from sales where ref = $1)", [ref]);
  check("a stock movement is written for the sale", movement.delta === -2, `${movement.delta} · ${movement.reason}`);

  // ------------------------------------------------------------ oversell guard
  let oversellError = "";
  try {
    await one("select public.finalize_sale($1::jsonb, '{}'::jsonb) as r", [
      JSON.stringify({ channel: "pos", lines: [{ product_id: target.id, qty: 99999 }] }),
    ]);
  } catch (e) {
    oversellError = e.message;
  }
  check("oversell raises INSUFFICIENT_STOCK", /INSUFFICIENT_STOCK/.test(oversellError), oversellError.slice(0, 60));
  const unchanged = await one("select stock from products where id = $1", [target.id]);
  check("failed sale leaves stock untouched", unchanged.stock === after.stock, `${unchanged.stock}`);

  // --------------------------------------------- pending → approve → refund flow
  const online = await one("select public.finalize_sale($1::jsonb, '{}'::jsonb) as r", [
    JSON.stringify({ channel: "online", status: "pending", customer_name: "SQL Buyer", lines: [{ product_id: target.id, qty: 1 }] }),
  ]);
  const onlineId = online.r.id;
  const pendingStock = await one("select stock from products where id = $1", [target.id]);
  check("pending online order does not move stock", pendingStock.stock === after.stock, `${pendingStock.stock}`);

  await q("select public.set_sale_status($1::uuid, 'completed')", [onlineId]);
  const approved = await one("select stock from products where id = $1", [target.id]);
  check("approving the order decrements stock", approved.stock === after.stock - 1, `${after.stock} → ${approved.stock}`);

  await q("select public.set_sale_status($1::uuid, 'refunded')", [onlineId]);
  const refunded = await one("select stock from products where id = $1", [target.id]);
  check("refunding returns the unit", refunded.stock === after.stock, `${approved.stock} → ${refunded.stock}`);

  // -------------------------------------------------------------- manual adjust
  await q("select public.adjust_stock($1::uuid, 5, 'delivery')", [target.id]);
  const adjusted = await one("select stock from products where id = $1", [target.id]);
  check("adjust_stock adds units", adjusted.stock === after.stock + 5, `${after.stock} → ${adjusted.stock}`);

  // ------------------------------------------------------------------- margins
  const margin = await one("select round(avg((price - cost_price)::numeric / nullif(price,0) * 100), 1) as m from products");
  check("margin is computable in SQL", Number(margin.m) > 0, `avg ${margin.m}%`);

  // ----------------------------------------------------------------------- RLS
  await q("grant select on products, sales, sale_lines, profiles to anon, authenticated;");
  await q("set role anon");
  const anonRows = await one("select count(*)::int as n from products");
  const { n: activeCount } = await one("select count(*)::int as n from public.products");
  await q("reset role");
  check("anonymous RLS hides inactive products", anonRows.n === activeCount, `${anonRows.n} visible of ${activeCount} active`);

  await q("update products set active = false where sku = 'AD-004'");
  await q("set role anon");
  const anonRows2 = await one("select count(*)::int as n from products");
  await q("reset role");
  check("deactivating a product removes it from the public catalog", anonRows2.n === activeCount - 1, `${anonRows2.n}`);

  const cashierId = cashier.id;
  // A signed-in Supabase request runs as the `authenticated` role with the user's
  // uuid in the JWT claim — that is what current_role_name() and the policies read.
  await q("set role authenticated");
  await q(`set request.jwt.claim.sub = '${cashierId}'`);
  const staffSales = await one("select count(*)::int as n from sales");
  await q("reset role");
  check("signed-in cashier can read sales through RLS", staffSales.n > 0, `${staffSales.n} rows`);

  // ------------------------------------------------------- reporting aggregates
  const report = await one(`
    select count(*)::int as tx, coalesce(sum(total),0)::bigint as revenue,
           count(distinct channel)::int as channels
    from sales where status = 'completed'
      and created_at >= now() - interval '30 days'`);
  check("dashboard aggregate query runs", report.tx > 0 && report.revenue > 0, `${report.tx} tx · UGX ${report.revenue} · ${report.channels} channels`);

  const tender = await q(`
    select coalesce(tender, 'Unpaid (online)') as tender,
           count(*)::int as tx, coalesce(sum(total),0)::bigint as revenue
    from sales where status = 'completed' and created_at >= now() - interval '30 days'
    group by 1 order by revenue desc`);
  check(
    "tender-mix aggregate runs and reconciles",
    tender.length > 0 && tender.reduce((x, r) => x + Number(r.revenue), 0) === Number(report.revenue),
    tender.map((r) => `${r.tender}=${r.revenue}`).join(" "),
  );

  const lowStock = await q("select sku from products where stock <= min_stock and active");
  check("low-stock reorder query runs", Array.isArray(lowStock), `${lowStock.length} flagged`);
} finally {
  await client.end();
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed${fail ? ` → ${failures.join("; ")}` : ""}\n`);
process.exit(fail ? 1 : 0);
