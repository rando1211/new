-- Milestone 1: row-level security scoped by dealer_id.
--
-- Access model:
--   anon           no table access; the public API writes through service_role
--                  after validation, rate limiting and Turnstile.
--   authenticated  members read their dealers' rows; admins also manage config
--                  (rooftops, feeds, model_aliases) and interests.
--   service_role   bypasses RLS; used by edge functions (ingest, diff, match, send).

-- Helpers live outside the exposed public schema.
create schema if not exists app;
grant usage on schema app to authenticated;

create or replace function app.user_dealer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select dealer_id from public.dealer_members where user_id = auth.uid();
$$;

create or replace function app.user_admin_dealer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select dealer_id from public.dealer_members where user_id = auth.uid() and role = 'admin';
$$;

revoke all on function app.user_dealer_ids() from public;
revoke all on function app.user_admin_dealer_ids() from public;
grant execute on function app.user_dealer_ids() to authenticated;
grant execute on function app.user_admin_dealer_ids() to authenticated;

-- Defense in depth: anon gets nothing, even if a policy is later added by mistake.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

alter table public.dealers        enable row level security;
alter table public.dealer_members enable row level security;
alter table public.rooftops       enable row level security;
alter table public.model_aliases  enable row level security;
alter table public.feeds          enable row level security;
alter table public.feed_runs      enable row level security;
alter table public.units          enable row level security;
alter table public.unit_events    enable row level security;
alter table public.interests      enable row level security;
alter table public.lead_sends     enable row level security;

-- dealers: members read their own dealer.
create policy dealers_select on public.dealers
  for select to authenticated
  using (id in (select app.user_dealer_ids()));

-- dealer_members: members see who else belongs to their dealer. Membership is
-- managed by service_role only, so a user can never grant themselves access.
create policy dealer_members_select on public.dealer_members
  for select to authenticated
  using (dealer_id in (select app.user_dealer_ids()));

-- Read access for every dealer-scoped table.
create policy rooftops_select      on public.rooftops      for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy model_aliases_select on public.model_aliases for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy feeds_select         on public.feeds         for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy feed_runs_select     on public.feed_runs     for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy units_select         on public.units         for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy unit_events_select   on public.unit_events   for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy interests_select     on public.interests     for select to authenticated using (dealer_id in (select app.user_dealer_ids()));
create policy lead_sends_select    on public.lead_sends    for select to authenticated using (dealer_id in (select app.user_dealer_ids()));

-- Admin writes on config tables and interests. WITH CHECK stops a row from
-- being inserted into, or moved to, a dealer the user doesn't administer.
create policy rooftops_admin_insert on public.rooftops for insert to authenticated
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy rooftops_admin_update on public.rooftops for update to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()))
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy rooftops_admin_delete on public.rooftops for delete to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()));

create policy model_aliases_admin_insert on public.model_aliases for insert to authenticated
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy model_aliases_admin_update on public.model_aliases for update to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()))
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy model_aliases_admin_delete on public.model_aliases for delete to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()));

create policy feeds_admin_insert on public.feeds for insert to authenticated
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy feeds_admin_update on public.feeds for update to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()))
  with check (dealer_id in (select app.user_admin_dealer_ids()));
create policy feeds_admin_delete on public.feeds for delete to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()));

-- Admins can edit or close out interests (e.g. mark unsubscribed); creation
-- goes through the public API.
create policy interests_admin_update on public.interests for update to authenticated
  using (dealer_id in (select app.user_admin_dealer_ids()))
  with check (dealer_id in (select app.user_admin_dealer_ids()));

-- feed_runs, units, unit_events and lead_sends have no write policies:
-- only the pipeline (service_role) writes them.
