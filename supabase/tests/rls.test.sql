-- Milestone 1 acceptance: migrations apply, the DAMG seed is present, a dealer
-- can only read and write its own rows, and the idempotency keys hold.
-- Runs in one transaction that is rolled back.

begin;

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.check(ok boolean, msg text) returns void
language plpgsql as $$
begin
  if ok is distinct from true then
    raise exception 'FAIL: %', msg;
  end if;
  raise notice 'ok - %', msg;
end $$;

-- Runs sql and asserts it fails with the given SQLSTATE.
create function tests.expect_error(sql text, sqlstate_expected text, msg text) returns void
language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: % (statement succeeded)', msg;
exception
  when others then
    if sqlstate <> sqlstate_expected then
      raise exception 'FAIL: % (got % %, expected %)', msg, sqlstate, sqlerrm, sqlstate_expected;
    end if;
    raise notice 'ok - %', msg;
end $$;

-- Runs sql and returns the number of rows it touched.
create function tests.rows(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Switch to an authenticated user (or anon / service_role when user_id is null).
create function tests.act_as(role_name text, user_id uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    coalesce(json_build_object('sub', user_id, 'role', role_name)::text, ''), true);
  execute format('set local role %I', role_name);
end $$;
grant execute on function tests.act_as(text, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

select tests.check((select count(*) from dealers where slug = 'damg') = 1, 'seed: dealer damg exists once');
select tests.check((select count(*) from rooftops r join dealers d on d.id = r.dealer_id where d.slug = 'damg') = 8,
                   'seed: damg has eight rooftops (seed re-run did not duplicate)');
select tests.check((select adf_inbox_email from rooftops where store_code = 'vista') = 'vistaleads@delamoms.com',
                   'seed: Vista ADF inbox set');
select tests.check((select count(*) from rooftops where adf_inbox_email is null) = 7, 'seed: unconfirmed ADF inboxes left null');
select tests.check((select count(*) from feeds f join dealers d on d.id = f.dealer_id
                    where d.slug = 'damg' and f.format = 'fb_catalog_csv' and f.schedule = '0 * * * *') = 1,
                   'seed: damg Pixel Motion feed, hourly');

-- ---------------------------------------------------------------------------
-- Fixtures: a second dealer and one row per table for each dealer
-- ---------------------------------------------------------------------------

insert into dealers (id, name, slug) values ('00000000-0000-0000-0000-0000000000b0', 'Other Powersports', 'other');
insert into rooftops (id, dealer_id, name, store_code)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b0', 'Other Main', 'main');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000aa01', 'damg-admin@example.com'),
  ('00000000-0000-0000-0000-00000000aa02', 'damg-viewer@example.com'),
  ('00000000-0000-0000-0000-00000000bb01', 'other-admin@example.com'),
  ('00000000-0000-0000-0000-00000000cc01', 'nobody@example.com');

insert into dealer_members (dealer_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000aa01'::uuid, 'admin'::member_role from dealers where slug = 'damg'
union all
select id, '00000000-0000-0000-0000-00000000aa02', 'viewer' from dealers where slug = 'damg'
union all
select id, '00000000-0000-0000-0000-00000000bb01', 'admin' from dealers where slug = 'other';

insert into feeds (dealer_id, url)
values ('00000000-0000-0000-0000-0000000000b0', 'https://example.com/other.csv');

insert into feed_runs (dealer_id, feed_id, row_count, status)
select dealer_id, id, 10, 'succeeded' from feeds;

insert into model_aliases (dealer_id, alias, model_key)
select id, 'ninja-400-abs', 'kawasaki-ninja-400' from dealers;

insert into units (dealer_id, rooftop_id, vin, stock_no, condition, year, make, model, model_key, price)
select r.dealer_id, r.id, 'VIN-' || d.slug, 'STK-' || d.slug, 'new', 2026, 'Kawasaki', 'Ninja 400', 'kawasaki-ninja-400', 5999
from rooftops r join dealers d on d.id = r.dealer_id
where r.store_code in ('orange-county', 'main');

insert into unit_events (dealer_id, unit_id, type, event_key)
select dealer_id, id, 'added', vin || ':added:2026-10-23' from units;

insert into interests (dealer_id, model_key, condition, name, email, consent_email)
select id, 'kawasaki-ninja-400', 'new', 'Pat Shopper', 'pat@example.com', true from dealers;

insert into lead_sends (dealer_id, interest_id, unit_event_id, channel)
select i.dealer_id, i.id, e.id, 'adf'
from interests i join unit_events e on e.dealer_id = i.dealer_id;

-- ---------------------------------------------------------------------------
-- Reads: each member sees only their own dealer
-- ---------------------------------------------------------------------------

select tests.act_as('authenticated', '00000000-0000-0000-0000-00000000aa02');  -- damg viewer
select tests.check((select count(*) from dealers) = 1 and (select slug from dealers) = 'damg', 'viewer: sees only own dealer');
select tests.check((select count(*) from rooftops) = 8, 'viewer: sees own 8 rooftops, not other dealer''s');
select tests.check((select count(*) from dealer_members) = 2, 'viewer: sees own dealer''s members only');
select tests.check((select count(*) from feeds) = 1, 'viewer: feeds scoped');
select tests.check((select count(*) from feed_runs) = 1, 'viewer: feed_runs scoped');
select tests.check((select count(*) from model_aliases) = 1, 'viewer: model_aliases scoped');
select tests.check((select count(*) from units) = 1 and (select vin from units) = 'VIN-damg', 'viewer: units scoped');
select tests.check((select count(*) from unit_events) = 1, 'viewer: unit_events scoped');
select tests.check((select count(*) from interests) = 1, 'viewer: interests scoped');
select tests.check((select count(*) from lead_sends) = 1, 'viewer: lead_sends scoped');
select tests.check(not exists (select 1 from units where dealer_id = '00000000-0000-0000-0000-0000000000b0'),
                   'viewer: filtering by another dealer_id returns nothing');

-- Viewers can't write config.
select tests.check(tests.rows($$update rooftops set name = 'x'$$) = 0, 'viewer: cannot update rooftops');
select tests.expect_error($$insert into feeds (dealer_id, url) select id, 'https://x' from dealers$$,
                          '42501', 'viewer: cannot insert feeds');
reset role;

select tests.act_as('authenticated', '00000000-0000-0000-0000-00000000bb01');  -- other admin
select tests.check((select count(*) from dealers) = 1 and (select slug from dealers) = 'other', 'other admin: sees only own dealer');
select tests.check((select count(*) from rooftops) = 1, 'other admin: sees own rooftop only');
select tests.check((select count(*) from units) = 1 and (select vin from units) = 'VIN-other', 'other admin: units scoped');
select tests.check((select count(*) from lead_sends) = 1, 'other admin: lead_sends scoped');

-- Admin writes stay inside their own dealer.
select tests.check(tests.rows($$update rooftops set timezone = 'America/Denver'$$) = 1, 'other admin: updates own rooftop');
select tests.check(tests.rows($$update rooftops set name = 'hijack' where store_code = 'vista'$$) = 0,
                   'other admin: cannot update damg rooftop');
select tests.check(tests.rows($$delete from feeds where url like '%pixelmotion%'$$) = 0,
                   'other admin: cannot delete damg feed');
select tests.check(tests.rows($$update interests set unsubscribed_at = now()$$) = 1,
                   'other admin: closes own interest only');
select tests.expect_error(
  $$insert into rooftops (dealer_id, name, store_code) values ((select id from dealers where slug = 'damg'), 'Rogue', 'rogue')$$,
  '42501', 'other admin: cannot insert rooftop for damg');
select tests.expect_error(
  $$update rooftops set dealer_id = (select dealer_id from dealer_members where role = 'viewer' limit 1)$$,
  '42501', 'other admin: cannot move a rooftop to another dealer');
select tests.expect_error(
  $$insert into dealer_members (dealer_id, user_id, role) select id, '00000000-0000-0000-0000-00000000bb01', 'admin' from dealers$$,
  '42501', 'other admin: cannot write memberships');
select tests.check(tests.rows($$update units set price = 1$$) = 0, 'admin: cannot write pipeline tables (units)');
select tests.expect_error($$insert into unit_events (dealer_id, unit_id, type, event_key) select dealer_id, id, 'sold', 'x' from units$$,
                          '42501', 'admin: cannot insert unit_events');
reset role;

select tests.act_as('authenticated', '00000000-0000-0000-0000-00000000cc01');  -- no membership
select tests.check((select count(*) from dealers) + (select count(*) from rooftops) + (select count(*) from units)
                   + (select count(*) from interests) + (select count(*) from lead_sends) = 0,
                   'non-member: sees nothing');
reset role;

select tests.act_as('anon', null);
select tests.expect_error($$select count(*) from interests$$, '42501', 'anon: no table access (interests)');
select tests.expect_error($$select count(*) from rooftops$$, '42501', 'anon: no table access (rooftops)');
select tests.expect_error($$insert into interests (dealer_id, model_key, email) select gen_random_uuid(), 'x', 'a@b.c'$$,
                          '42501', 'anon: cannot insert interests directly');
reset role;

select tests.act_as('service_role', null);
select tests.check((select count(*) from dealers) = 2 and (select count(*) from units) = 2, 'service_role: sees all dealers');
reset role;

-- ---------------------------------------------------------------------------
-- Integrity and idempotency
-- ---------------------------------------------------------------------------

select tests.expect_error(
  $$insert into units (dealer_id, rooftop_id, vin, model_key)
    values ((select id from dealers where slug = 'damg'), '00000000-0000-0000-0000-0000000000b1', 'X', 'x')$$,
  '23503', 'integrity: unit cannot reference another dealer''s rooftop');
select tests.expect_error(
  $$insert into lead_sends (dealer_id, interest_id, unit_event_id, channel)
    select i.dealer_id, i.id, e.id, 'email' from interests i, unit_events e where i.dealer_id <> e.dealer_id limit 1$$,
  '23503', 'integrity: lead_send cannot pair an interest with another dealer''s event');
select tests.expect_error(
  $$insert into lead_sends (dealer_id, interest_id, unit_event_id, channel) select dealer_id, interest_id, unit_event_id, channel from lead_sends limit 1$$,
  '23505', 'idempotency: duplicate (interest, event, channel) lead send rejected');
select tests.expect_error(
  $$insert into unit_events (dealer_id, unit_id, type, event_key) select dealer_id, unit_id, type, event_key from unit_events limit 1$$,
  '23505', 'idempotency: duplicate event_key rejected');
select tests.expect_error(
  $$insert into units (dealer_id, rooftop_id, vin, model_key) select dealer_id, rooftop_id, vin, model_key from units limit 1$$,
  '23505', 'idempotency: one unit per (dealer, vin)');
select tests.expect_error(
  $$insert into interests (dealer_id, model_key, email) select id, 'kawasaki-ninja-400', 'PAT@example.com' from dealers where slug = 'damg'$$,
  '23505', 'dedupe: open interest on same dealer, email (case-insensitive) and model');
select tests.check(tests.rows(
  $$insert into interests (dealer_id, model_key, email) select id, 'kawasaki-ninja-400', 'pat@example.com' from dealers where slug = 'other'$$) = 1,
  'dedupe: closed (unsubscribed) interest does not block a new one');
select tests.expect_error(
  $$insert into interests (dealer_id, model_key, name) select id, 'x', 'No Contact' from dealers limit 1$$,
  '23514', 'interests: email or phone required');
select tests.expect_error(
  $$insert into interests (dealer_id, model_key, email, consent_sms) select id, 'x', 'a@b.c', true from dealers limit 1$$,
  '23514', 'interests: SMS consent needs a phone and consent timestamp');

rollback;
