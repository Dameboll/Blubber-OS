-- Blubber-OS cloud backing: Academy waitlist + entitlements + OTP login
--
-- Replaces the local per-machine SQLite waitlist (src/server/waitlist-store.ts)
-- with a shared cloud table Dame can actually see aggregate signups in, and
-- lays the Supabase-side groundwork for a future Shopify-sold "Starter Kit" /
-- "All Access" entitlement system (Shopify integration itself happens later).
--
-- Security model (this is a PUBLIC desktop app — the anon key ships inside it
-- and can be extracted by anyone who wants to look):
--   - waitlist:      RLS enabled, anon may INSERT only. No SELECT/UPDATE/DELETE
--                    policy exists for anon/authenticated, so those are denied
--                    by default. A case-insensitive unique index means a
--                    repeated or differently-cased submit is a no-op, not a
--                    new row — the table can't be spam-grown by resubmits.
--   - entitlements:  RLS enabled, ZERO policies for anon/authenticated. Only
--                    the service_role key (used exclusively inside Edge
--                    Functions, never shipped client-side) can read or write.
--   - otp_codes:     Same deny-by-default posture as entitlements.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. waitlist — Academy "notify me" signups
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  -- Every writer (the waitlist-signup Edge Function, and any future direct
  -- caller) must normalize to lowercase before inserting. This makes the
  -- plain UNIQUE constraint above effectively case-insensitive and rejects
  -- (rather than silently duplicates) any non-normalized direct insert.
  constraint waitlist_email_lowercase check (email = lower(email))
);

alter table public.waitlist enable row level security;

create policy "waitlist_anon_insert_only"
  on public.waitlist
  for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------------
-- 2. entitlements — Shopify-purchased product access
-- ---------------------------------------------------------------------------
create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  product text not null check (product in ('starter_kit', 'all_access')),
  shopify_order_id text,
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- The shopify-webhook function always lowercases email before writing here.
  constraint entitlements_email_lowercase check (email = lower(email)),
  -- One row per (email, product): a repeat webhook delivery for the same
  -- order upserts the existing row instead of duplicating it.
  constraint entitlements_email_product_key unique (email, product)
);

create index if not exists entitlements_email_idx
  on public.entitlements (email);

alter table public.entitlements enable row level security;
-- No policies created — RLS + zero policies = deny-all for anon/authenticated.
-- Only service_role (Edge Functions only) can touch this table.

-- ---------------------------------------------------------------------------
-- 3. otp_codes — short-lived login codes for entitlement holders
-- ---------------------------------------------------------------------------
create table if not exists public.otp_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists otp_codes_email_idx
  on public.otp_codes (email);

alter table public.otp_codes enable row level security;
-- Same deny-by-default posture as entitlements — service_role only.
