-- Milestone 1: core schema for the inventory demand layer.
--
-- Tenancy: every row carries dealer_id. Child tables reference their parent by
-- (id, dealer_id) so a row can never point at another dealer's parent.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.member_role as enum ('admin', 'viewer');
create type public.feed_format as enum ('fb_catalog_csv');
create type public.feed_run_status as enum ('running', 'succeeded', 'failed');
create type public.unit_condition as enum ('new', 'used');
create type public.unit_event_type as enum ('added', 'sold', 'price_drop', 'aged_60', 'aged_90');
create type public.lead_channel as enum ('adf', 'email', 'sms');
create type public.lead_send_status as enum ('pending', 'sent', 'failed');

-- ---------------------------------------------------------------------------
-- Dealers and membership
-- ---------------------------------------------------------------------------

create table public.dealers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at  timestamptz not null default now()
);

-- Maps Supabase Auth users to the dealers whose admin data they can see.
create table public.dealer_members (
  dealer_id   uuid not null references public.dealers (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.member_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  primary key (dealer_id, user_id)
);
create index dealer_members_user_id_idx on public.dealer_members (user_id);

create table public.rooftops (
  id               uuid primary key default gen_random_uuid(),
  dealer_id        uuid not null references public.dealers (id) on delete cascade,
  name             text not null,
  store_code       text not null check (store_code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  adf_inbox_email  text,                   -- null until confirmed; sender skips rooftops without one
  sales_email      text,                   -- reply-to for shopper email
  site_url         text,
  postal_address   text,                   -- CAN-SPAM footer
  timezone         text not null default 'America/Los_Angeles',
  created_at       timestamptz not null default now(),
  unique (dealer_id, store_code),
  unique (id, dealer_id)
);

-- Per-dealer feed quirks: normalized raw model string -> canonical model_key.
create table public.model_aliases (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid not null references public.dealers (id) on delete cascade,
  alias       text not null,
  model_key   text not null,
  created_at  timestamptz not null default now(),
  unique (dealer_id, alias)
);

-- ---------------------------------------------------------------------------
-- Feeds
-- ---------------------------------------------------------------------------

create table public.feeds (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid not null references public.dealers (id) on delete cascade,
  url          text not null,
  format       public.feed_format not null default 'fb_catalog_csv',
  schedule     text not null default '0 * * * *',   -- cron, hourly by default
  is_active    boolean not null default true,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (dealer_id, url),
  unique (id, dealer_id)
);

create table public.feed_runs (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid not null,
  feed_id      uuid not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  row_count    integer check (row_count >= 0),
  status       public.feed_run_status not null default 'running',
  error        text,
  unique (id, dealer_id),
  foreign key (feed_id, dealer_id) references public.feeds (id, dealer_id) on delete cascade
);
create index feed_runs_feed_started_idx on public.feed_runs (feed_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Units (current state) and their events
-- ---------------------------------------------------------------------------

create table public.units (
  id                uuid primary key default gen_random_uuid(),
  dealer_id         uuid not null,
  rooftop_id        uuid not null,
  vin               text,
  stock_no          text,
  condition         public.unit_condition,
  year              integer check (year between 1900 and 2100),
  make              text,
  model             text,
  trim              text,
  model_key         text not null,
  price             numeric(12, 2) check (price >= 0),
  url               text,
  image_url         text,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  missed_runs       integer not null default 0 check (missed_runs >= 0),  -- consecutive successful runs without this unit
  sold_at           timestamptz,
  check (vin is not null or stock_no is not null),
  unique (id, dealer_id),
  foreign key (rooftop_id, dealer_id) references public.rooftops (id, dealer_id) on delete cascade,
  foreign key (dealer_id) references public.dealers (id) on delete cascade
);
-- Upsert key: VIN when present, stock number otherwise.
create unique index units_dealer_vin_key on public.units (dealer_id, vin) where vin is not null;
create unique index units_dealer_stock_no_key on public.units (dealer_id, stock_no) where vin is null;
-- In-stock lookups for matching and the widget's stock count.
create index units_in_stock_model_idx on public.units (dealer_id, model_key, condition) where sold_at is null;

create table public.unit_events (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid not null,
  unit_id       uuid not null,
  type          public.unit_event_type not null,
  event_key     text not null,              -- deterministic: vin + type + run date
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  unique (dealer_id, event_key),
  unique (id, dealer_id),
  foreign key (unit_id, dealer_id) references public.units (id, dealer_id) on delete cascade
);
create index unit_events_unprocessed_idx on public.unit_events (created_at) where processed_at is null;
create index unit_events_dealer_created_idx on public.unit_events (dealer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Shopper interests and lead sends
-- ---------------------------------------------------------------------------

create table public.interests (
  id              uuid primary key default gen_random_uuid(),
  dealer_id       uuid not null references public.dealers (id) on delete cascade,
  rooftop_id      uuid,                       -- null = any store
  model_key       text not null,
  vin             text,                       -- set when waiting on a specific unit
  condition       public.unit_condition,      -- null = new or used
  name            text,
  email           text,
  phone           text,                       -- E.164, normalized by the API
  consent_email   boolean not null default false,
  consent_sms     boolean not null default false,
  consent_text    text,                       -- exact opt-in wording shown
  consent_at      timestamptz,
  source_url      text,
  referrer        text,
  utm             jsonb not null default '{}'::jsonb,
  gclid           text,
  fbclid          text,
  created_at      timestamptz not null default now(),
  fulfilled_at    timestamptz,
  unsubscribed_at timestamptz,
  check (email is not null or phone is not null),
  check (not consent_sms or (phone is not null and consent_at is not null)),
  unique (id, dealer_id),
  foreign key (rooftop_id, dealer_id) references public.rooftops (id, dealer_id) on delete set null (rooftop_id)
);
-- Dedupe open interests on (dealer, email or phone, model_key).
create unique index interests_open_email_key
  on public.interests (dealer_id, lower(email), model_key)
  where email is not null and fulfilled_at is null and unsubscribed_at is null;
create unique index interests_open_phone_key
  on public.interests (dealer_id, phone, model_key)
  where phone is not null and fulfilled_at is null and unsubscribed_at is null;
create index interests_open_model_idx
  on public.interests (dealer_id, model_key)
  where fulfilled_at is null and unsubscribed_at is null;
create index interests_vin_idx on public.interests (dealer_id, vin) where vin is not null;

create table public.lead_sends (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null,
  interest_id    uuid not null,
  unit_event_id  uuid not null,
  channel        public.lead_channel not null,
  status         public.lead_send_status not null default 'pending',
  attempts       integer not null default 0 check (attempts >= 0),
  provider_id    text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  error          text,
  -- Idempotency: one send per shopper, event and channel, however often the matcher retries.
  unique (interest_id, unit_event_id, channel),
  foreign key (interest_id, dealer_id) references public.interests (id, dealer_id) on delete cascade,
  foreign key (unit_event_id, dealer_id) references public.unit_events (id, dealer_id) on delete cascade
);
create index lead_sends_dealer_created_idx on public.lead_sends (dealer_id, created_at desc);
create index lead_sends_unit_event_idx on public.lead_sends (unit_event_id);
