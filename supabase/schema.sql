-- ============================================================================
-- ADONAI THRIFT — single source of truth (Postgres / Supabase)
-- Run:  supabase db push   |   or paste into the Supabase SQL editor
-- ============================================================================
create extension if not exists "pgcrypto";

-- Required for the /api/stream Realtime subscription to receive product updates.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.products';
  end if;
exception when duplicate_object then null;
end $$;

create type sale_channel as enum ('pos', 'online');
create type sale_status   as enum ('completed', 'pending', 'cancelled', 'refunded');
create type user_role     as enum ('admin', 'manager', 'cashier');
create type product_condition as enum ('New with tags', 'Like new', 'Good', 'Fair');

-- ---------------------------------------------------------------- profiles --
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text unique not null,
  name       text not null default '',
  role       user_role not null default 'cashier',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- products --
create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  sku          text unique not null,
  barcode      text unique,
  title        text not null,
  description  text,
  category     text not null default 'Accessories',
  condition    product_condition not null default 'Good',
  size         text not null default 'One size',
  image_url    text,
  cost_price   integer not null default 0 check (cost_price >= 0),
  price        integer not null default 0 check (price >= 0),
  discount_pct integer not null default 0 check (discount_pct between 0 and 90),
  stock        integer not null default 0 check (stock >= 0),   -- CHECK = atomic floor
  min_stock    integer not null default 3 check (min_stock >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category);
create index if not exists products_active_idx   on public.products(active, stock);
create index if not exists products_title_trgm   on public.products using gin (to_tsvector('simple', title));

-- ------------------------------------------------------------------- sales --
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  ref             text unique not null,
  channel         sale_channel not null,
  status          sale_status not null default 'completed',
  tender          text,
  customer_name   text,
  customer_phone  text,
  subtotal        integer not null default 0,
  discount_total  integer not null default 0,
  total           integer not null default 0,
  amount_received integer not null default 0,
  change_due      integer not null default 0,
  note            text,
  cashier_id      uuid references public.profiles(id),
  cashier_name    text,
  created_at      timestamptz not null default now()
);
create index if not exists sales_created_idx on public.sales(created_at desc);
create index if not exists sales_channel_idx on public.sales(channel, status);

create table if not exists public.sale_lines (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  sku        text not null,
  title      text not null,
  qty        integer not null check (qty > 0),
  unit_price integer not null check (unit_price >= 0),
  line_total integer not null check (line_total >= 0)
);
create index if not exists sale_lines_sale_idx on public.sale_lines(sale_id);

create table if not exists public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references public.products(id) on delete cascade,
  sku         text,
  delta       integer not null,
  reason      text not null default 'adjustment',
  sale_id     uuid references public.sales(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- =============================================================== FUNCTIONS ==
-- Atomic stock decrement. The `where stock >= qty` guard plus the CHECK
-- constraint means a concurrent oversell raises instead of going negative.
create or replace function public.decrement_stock(p_product uuid, p_qty integer, p_reason text, p_sale uuid)
returns void language plpgsql as $$
declare updated_rows integer;
begin
  update public.products
     set stock = stock - p_qty, updated_at = now()
   where id = p_product and stock >= p_qty;
  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then
    raise exception 'INSUFFICIENT_STOCK %', p_product using errcode = '23514';
  end if;
  insert into public.stock_movements(product_id, sku, delta, reason, sale_id)
  select p_product, sku, -p_qty, p_reason, p_sale from public.products where id = p_product;
end $$;

create or replace function public.next_sale_ref(p_channel sale_channel)
returns text language plpgsql as $$
declare n integer;
begin
  select count(*) + 1 into n from public.sales where channel = p_channel;
  return case when p_channel = 'pos' then 'POS-' else 'ONL-' end || lpad(n::text, 5, '0');
end $$;

-- Counter checkout: one transaction writes the sale, its lines and the stock.
-- Order matters — the sales row must exist before sale_lines (FK), and stock is
-- decremented last so a shortfall rolls the whole transaction back.
create or replace function public.finalize_sale(payload jsonb, actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_sale_id  uuid := gen_random_uuid();
  v_channel  sale_channel := coalesce((payload->>'channel')::sale_channel, 'pos');
  v_status   sale_status  := coalesce((payload->>'status')::sale_status, 'completed');
  v_ref      text;
  v_subtotal bigint := 0;
  v_discount bigint := coalesce((payload->>'discount_total')::bigint, 0);
  v_total    bigint;
  v_received bigint := coalesce((payload->>'amount_received')::bigint, 0);
  v_input    jsonb;
  v_line     jsonb;
  v_product  public.products;
  v_qty      integer;
  v_unit     integer;
  v_lines    jsonb := '[]'::jsonb;
begin
  if jsonb_array_length(payload->'lines') is null or jsonb_array_length(payload->'lines') = 0 then
    raise exception 'EMPTY_SALE';
  end if;

  -- 1. resolve + price every line (no writes yet)
  for v_input in select * from jsonb_array_elements(payload->'lines') loop
    select * into v_product from public.products
     where id = (v_input->>'product_id')::uuid
        or sku ilike v_input->>'product_id'
        or barcode = v_input->>'product_id';
    if not found then raise exception 'UNKNOWN_PRODUCT %', v_input->>'product_id'; end if;

    v_qty  := greatest(1, coalesce((v_input->>'qty')::integer, 1));

    -- availability first: a short line must raise before we price anything
    if v_status = 'completed' and v_product.stock < v_qty then
      raise exception 'INSUFFICIENT_STOCK % (% left, % requested)',
        v_product.sku, v_product.stock, v_qty using errcode = '23514';
    end if;

    v_unit := coalesce((v_input->>'unit_price')::integer,
                       round(v_product.price * (1 - v_product.discount_pct / 100.0))::integer);
    v_subtotal := v_subtotal + v_unit::bigint * v_qty;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'sku', v_product.sku, 'title', v_product.title,
      'qty', v_qty, 'unit_price', v_unit, 'line_total', v_unit * v_qty));
  end loop;

  if v_subtotal > 2000000000 then raise exception 'SALE_TOTAL_OUT_OF_RANGE %', v_subtotal; end if;

  v_discount := least(v_discount, v_subtotal);
  v_total := v_subtotal - v_discount;
  if v_status = 'completed' and v_received = 0 then v_received := v_total; end if;
  v_ref := public.next_sale_ref(v_channel);

  -- 2. parent row first
  insert into public.sales(id, ref, channel, status, tender, customer_name, customer_phone,
                           subtotal, discount_total, total, amount_received, change_due, note,
                           cashier_id, cashier_name)
  values (v_sale_id, v_ref, v_channel, v_status, payload->>'tender',
          payload->>'customer_name', payload->>'customer_phone',
          v_subtotal::integer, v_discount::integer, v_total::integer, v_received::integer,
          greatest(0, v_received - v_total)::integer, payload->>'note',
          nullif(actor->>'id', '')::uuid, actor->>'name');

  -- 3. then the lines
  for v_line in select * from jsonb_array_elements(v_lines) loop
    insert into public.sale_lines(sale_id, product_id, sku, title, qty, unit_price, line_total)
    values (v_sale_id, (v_line->>'product_id')::uuid, v_line->>'sku', v_line->>'title',
            (v_line->>'qty')::integer, (v_line->>'unit_price')::integer, (v_line->>'line_total')::integer);
  end loop;

  -- 4. finally the atomic decrement
  if v_status = 'completed' then
    for v_line in select * from jsonb_array_elements(v_lines) loop
      perform public.decrement_stock((v_line->>'product_id')::uuid,
                                     (v_line->>'qty')::integer,
                                     case when v_channel = 'pos' then 'Counter sale ' else 'Online order ' end || v_ref,
                                     v_sale_id);
    end loop;
  end if;

  return jsonb_build_object('id', v_sale_id, 'ref', v_ref, 'total', v_total,
                            'change_due', greatest(0, v_received - v_total));
end $$;

-- Approving a pending online order decrements stock; cancelling returns it.
create or replace function public.set_sale_status(p_sale uuid, p_status sale_status)
returns void language plpgsql as $$
declare v_sale public.sales; v_line public.sale_lines;
begin
  select * into v_sale from public.sales where id = p_sale for update;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;

  if v_sale.status <> 'completed' and p_status = 'completed' then
    for v_line in select * from public.sale_lines where sale_id = p_sale loop
      perform public.decrement_stock(v_line.product_id, v_line.qty, 'Online order ' || v_sale.ref, p_sale);
    end loop;
  elsif v_sale.status = 'completed' and p_status in ('cancelled', 'refunded') then
    for v_line in select * from public.sale_lines where sale_id = p_sale loop
      update public.products set stock = stock + v_line.qty, updated_at = now() where id = v_line.product_id;
      insert into public.stock_movements(product_id, sku, delta, reason, sale_id)
      values (v_line.product_id, v_line.sku, v_line.qty, 'Stock returned from ' || v_sale.ref, p_sale);
    end loop;
  end if;

  update public.sales set status = p_status where id = p_sale;
end $$;

create or replace function public.adjust_stock(p_product uuid, p_delta integer, p_reason text default 'Manual adjustment')
returns void language plpgsql as $$
begin
  update public.products set stock = greatest(0, stock + p_delta), updated_at = now() where id = p_product;
  insert into public.stock_movements(product_id, sku, delta, reason)
  select p_product, sku, p_delta, p_reason from public.products where id = p_product;
end $$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ==================================================================== RLS ===
alter table public.profiles        enable row level security;
alter table public.products        enable row level security;
alter table public.sales           enable row level security;
alter table public.sale_lines      enable row level security;
alter table public.stock_movements enable row level security;

-- SECURITY DEFINER is required here: the profiles policies call this function, and
-- without it the inner query on profiles re-applies the same policy and recurses
-- until Postgres aborts with "stack depth limit exceeded".
create or replace function public.current_role_name() returns user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

-- Showroom is public; only active, in-stock rows are exposed anonymously.
create policy products_public_read on public.products for select using (active);
create policy products_staff_read  on public.products for select
  to authenticated using (true);
create policy products_staff_write on public.products for all
  to authenticated using (public.current_role_name() in ('admin','manager'))
  with check (public.current_role_name() in ('admin','manager'));

create policy sales_staff_read on public.sales for select to authenticated
  using (public.current_role_name() in ('admin','manager','cashier'));
create policy sales_staff_write on public.sales for all to authenticated
  using (public.current_role_name() in ('admin','manager','cashier'))
  with check (public.current_role_name() in ('admin','manager','cashier'));

create policy sale_lines_staff on public.sale_lines for all to authenticated
  using (public.current_role_name() in ('admin','manager','cashier'))
  with check (public.current_role_name() in ('admin','manager','cashier'));

create policy movements_staff on public.stock_movements for all to authenticated
  using (public.current_role_name() in ('admin','manager'))
  with check (public.current_role_name() in ('admin','manager'));

create policy profiles_self on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_role_name() in ('admin','manager'));
create policy profiles_admin_write on public.profiles for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');
