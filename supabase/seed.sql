-- ============================================================================
-- ADONAI THRIFT — demo seed (run AFTER schema.sql)
--   1. staff accounts   2. catalog   3. three weeks of mixed POS/online sales
-- ============================================================================

-- ------------------------------------------------------ 1. staff accounts --
-- Fastest path for a dev project. In production create users in the Supabase
-- dashboard (Authentication → Users) and only run the profiles insert.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'admin@adonai.ug',   crypt('adonai-admin',   gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"name":"Andrew Senyonga"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'manager@adonai.ug', crypt('adonai-manager', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"name":"Grace Nabirye"}',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'cashier@adonai.ug', crypt('adonai-cashier', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"name":"Ivan Kato"}',      now(), now())
on conflict (email) do nothing;

insert into public.profiles (id, email, name, role)
select id, email, coalesce(raw_user_meta_data->>'name', email),
       case when email = 'admin@adonai.ug' then 'admin'::user_role
            when email = 'manager@adonai.ug' then 'manager'::user_role
            else 'cashier'::user_role end
from auth.users where email like '%@adonai.ug'
on conflict (id) do nothing;

-- ---------------------------------------------------------------- 2. catalog --
insert into public.products (sku, barcode, title, description, category, condition, size, cost_price, price, stock, min_stock, discount_pct)
values
  ('AD-001', '2000000000016', 'Floral Midi Wrap Dress',      'Bale select, washed and quality-checked in store.', 'Dresses',        'Like new',        'UK 10',    12000, 35000,  6, 3, 0),
  ('AD-002', '2000000000023', 'Ankara Print Party Dress',    'Bale select, washed and quality-checked in store.', 'Dresses',        'Good',            'UK 8',      9000, 28000,  4, 3, 0),
  ('AD-003', '2000000000030', 'Linen Shift Dress — Beige',   'New with tags, never worn.',                        'Dresses',        'New with tags',   'UK 12',    16000, 48000,  3, 3, 0),
  ('AD-004', '2000000000047', 'Denim Button Front Dress',    'Bale select, washed and quality-checked in store.', 'Dresses',        'Good',            'UK 10',    11000, 32000,  0, 3, 0),
  ('AD-005', '2000000000054', 'Silk Blouse — Emerald',       'Bale select, washed and quality-checked in store.', 'Tops & Blouses', 'Like new',        'M',         8000, 24000,  9, 3, 0),
  ('AD-006', '2000000000061', 'Cotton Peplum Top',           'Everyday wear, 10% promo this week.',               'Tops & Blouses', 'Good',            'L',         6000, 18000, 12, 3, 10),
  ('AD-007', '2000000000078', 'Off-Shoulder Summer Blouse',  'Light marking on the cuff, priced accordingly.',    'Tops & Blouses', 'Fair',            'S',         4500, 14000,  7, 3, 0),
  ('AD-008', '2000000000085', 'High-Waist Skinny Jeans',     'Bale select, washed and quality-checked in store.', 'Jeans & Denim',  'Good',            'UK 10',    10000, 29000,  8, 3, 0),
  ('AD-009', '2000000000092', 'Boyfriend Jeans — Faded',     'Bale select, washed and quality-checked in store.', 'Jeans & Denim',  'Like new',        'UK 12',    12500, 36000,  5, 3, 0),
  ('AD-010', '2000000000108', 'Denim Jacket — Vintage Wash', 'Heavyweight vintage denim.',                        'Jackets & Coats','Good',            'M',        18000, 52000,  2, 3, 0),
  ('AD-011', '2000000000115', 'Trench Coat — Camel',         'Fully lined, belt included.',                       'Jackets & Coats','Like new',        'L',        26000, 75000,  1, 3, 0),
  ('AD-012', '2000000000122', 'Oxford Shirt — White',        'New with tags, never worn.',                        'Shirts',         'New with tags',   'L',         7000, 22000, 14, 3, 0),
  ('AD-013', '2000000000139', 'Floral Shirt — Short Sleeve', 'Bale select, washed and quality-checked in store.', 'Shirts',         'Good',            'M',         5500, 17000, 10, 3, 0),
  ('AD-014', '2000000000146', 'Cigarette Trousers — Black',  'Tailored fit, office ready.',                       'Trousers',       'Like new',        'UK 10',     8500, 26000,  6, 3, 0),
  ('AD-015', '2000000000153', 'Wide-Leg Linen Trousers',     'Breathable linen, warm-weather staple.',            'Trousers',       'Good',            'UK 12',     9500, 28000,  4, 3, 0),
  ('AD-016', '2000000000160', 'Pleated Midi Skirt',          'Bale select, washed and quality-checked in store.', 'Skirts',         'Good',            'UK 8',      7000, 21000,  5, 3, 0),
  ('AD-017', '2000000000177', 'Denim A-Line Skirt',          'Bale select, washed and quality-checked in store.', 'Skirts',         'Fair',            'UK 10',     5000, 15000,  9, 3, 0),
  ('AD-018', '2000000000184', 'Leather Ankle Boots',         'Resoled, worn twice.',                              'Shoes',          'Good',            '38',       22000, 62000,  3, 3, 0),
  ('AD-019', '2000000000191', 'White Canvas Sneakers',       'Cleaned in store.',                                 'Shoes',          'Like new',        '39',       18000, 52000,  4, 3, 0),
  ('AD-020', '2000000000207', 'Block Heel Pumps',            'Bale select, checked for wear.',                    'Shoes',          'Good',            '37',       15000, 45000,  2, 3, 0),
  ('AD-021', '2000000000214', 'Tote Handbag — Tan',          'Structured leather tote.',                          'Bags',           'Like new',        'One size', 16000, 48000,  3, 3, 0),
  ('AD-022', '2000000000221', 'Crossbody Satchel',           'Adjustable strap.',                                 'Bags',           'Good',            'One size',  9000, 27000,  6, 3, 0),
  ('AD-023', '2000000000238', 'Kids Denim Overalls (4-5y)',  'Bale select, washed and quality-checked in store.', 'Kids',           'Good',            'S',         5000, 16000, 11, 3, 0),
  ('AD-024', '2000000000245', 'Kids Tracksuit Set (6-7y)',   'New with tags, never worn.',                        'Kids',           'New with tags',   'M',         7000, 22000,  8, 3, 0)
on conflict (sku) do nothing;

-- ---------------------------------------- 3. three weeks of demo transactions --
-- Uses the real finalize_sale() RPC, so stock movements and refs are genuine.
-- finalize_sale() decrements as it goes, so remember the authored on-hand
-- quantities first and restore them afterwards — the shop is restocked from new
-- bales, exactly as the local demo driver leaves them.
create temp table seed_stock as select id, stock from public.products;

do $$
declare
  r record; d integer; i integer; n_lines integer; q integer;
  payload jsonb; lines jsonb; chan sale_channel;
  cashier_id uuid; cashier_name text;
begin
  select id, name into cashier_id, cashier_name from public.profiles where email = 'cashier@adonai.ug';
  if cashier_id is null then raise notice 'no cashier profile — skipping demo sales'; return; end if;

  for d in reverse 20..0 loop
    for i in 1..(3 + floor(random() * 6))::int loop
      chan := case when random() > 0.34 then 'pos'::sale_channel else 'online'::sale_channel end;
      n_lines := 1 + floor(random() * 2)::int;
      lines := '[]'::jsonb;
      for r in select id, price from public.products where stock > 0 order by random() limit n_lines loop
        q := case when random() > 0.85 then 2 else 1 end;
        lines := lines || jsonb_build_array(jsonb_build_object(
          'product_id', r.id, 'qty', q, 'unit_price', r.price));
      end loop;
      if jsonb_array_length(lines) = 0 then continue; end if;

      payload := jsonb_build_object(
        'channel', chan,
        'status', case when chan = 'pos' then 'completed' else (case when random() > 0.2 then 'completed' else 'pending' end) end,
        'tender', case when chan = 'pos' then (case when random() > 0.5 then 'Cash' else 'MTN MoMo' end) else null end,
        'customer_name', case when chan = 'online' then 'Demo Customer' else null end,
        'customer_phone', case when chan = 'online' then '+256700000000' else null end,
        'amount_received', 0,
        'discount_total', 0,
        'lines', lines
      );

      begin
        perform public.finalize_sale(payload, jsonb_build_object('id', cashier_id, 'name', cashier_name));
      exception when others then
        raise notice 'skipped demo sale: %', sqlerrm;
      end;

      -- backdate the transaction so the dashboard shows a trend
      update public.sales set created_at = created_at - (d || ' days')::interval
       where id = (select id from public.sales order by created_at desc limit 1);
    end loop;
  end loop;
end $$;

-- Restock: log the movement first so the audit trail still reconciles.
insert into public.stock_movements (product_id, sku, delta, reason)
select s.id, p.sku, s.stock - p.stock, 'Restock from new bale (demo)'
from seed_stock s join public.products p on p.id = s.id
where s.stock > p.stock;

update public.products p
   set stock = s.stock, updated_at = now()
from seed_stock s
where p.id = s.id;

drop table seed_stock;

select count(*) as products from public.products;
select count(*) as units_on_hand from public.products;
select channel, status, count(*) as sales, sum(total) as revenue_ugx from public.sales group by 1, 2 order by 1, 2;
