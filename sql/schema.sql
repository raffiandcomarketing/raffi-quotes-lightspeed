-- =====================================================================================
-- Raffi Quotes & Invoicing (Lightspeed DEV) — Supabase schema
-- Project: hjcgqxszwqmzirtlaxze (raffi-quotes-lightspeed, ca-central-1)
-- Test store only: developerdemoxeqwzt.retail.lightspeed.app (hard-locked in backend)
--
-- This file reproduces the live schema (dumped 2026-08-19). All tables have RLS
-- ENABLED. Only the listed SELECT policies exist; everything else is service-role
-- only (edge functions use the service role key). OAuth tokens in ls_connections
-- are therefore never readable with the anon key.
-- =====================================================================================

-- ---------- OAuth / connection state ----------
create table if not exists public.ls_connections (
  id uuid not null default gen_random_uuid(),
  domain_prefix text not null,
  retailer_id text,
  retailer_name text,
  environment text not null default 'test',
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  api_version text not null default '2026-07',
  status text not null default 'connected',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_refresh_at timestamptz,
  last_api_request_at timestamptz,
  last_api_request_op text,
  last_sync_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ls_connections_pkey primary key (id),
  constraint ls_connections_domain_prefix_key unique (domain_prefix),
  constraint ls_connections_environment_check check (environment in ('development','test','production')),
  constraint ls_connections_status_check check (status in ('connected','disconnected','error','refresh_failed'))
);

create table if not exists public.ls_oauth_states (
  state text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used boolean not null default false,
  return_to text,
  constraint ls_oauth_states_pkey primary key (state)
);

-- ---------- Idempotency + request audit ----------
create table if not exists public.ls_ops (
  op_id text not null,
  action text not null,
  request jsonb,
  response jsonb,
  http_status integer,
  created_at timestamptz not null default now(),
  constraint ls_ops_pkey primary key (op_id)
);

create table if not exists public.ls_request_log (
  id bigint generated always as identity,
  at timestamptz not null default now(),
  source text not null default 'api',
  op text,
  method text,
  path text,
  http_status integer,
  ok boolean,
  duration_ms integer,
  error text,
  meta jsonb,
  constraint ls_request_log_pkey primary key (id)
);

-- ---------- Shared app document (optimistic concurrency) ----------
create table if not exists public.raffi_app_state (
  id text not null,
  doc jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint raffi_app_state_pkey primary key (id)
);

-- ---------- Integration module hosting (served by fn raffi-module) ----------
create table if not exists public.raffi_module_chunks (
  seq integer not null,
  body text not null,
  updated_at timestamptz not null default now(),
  constraint raffi_module_chunks_pkey primary key (seq)
);
comment on table public.raffi_module_chunks is
  'Raffi Quotes & Invoicing Lightspeed integration module (app/raffi_module.js) stored as ordered text chunks; served by edge function raffi-module. Service-role only. Regenerate with scripts/build_module_chunks.py.';

-- ---------- Webhooks ----------
create table if not exists public.ls_webhook_events (
  id bigint generated always as identity,
  dedupe_key text not null,
  webhook_type text not null,
  domain_prefix text,
  payload jsonb,
  signature_valid boolean,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_status text not null default 'received',
  process_note text,
  constraint ls_webhook_events_pkey primary key (id),
  constraint ls_webhook_events_dedupe_key_key unique (dedupe_key),
  constraint ls_webhook_events_process_status_check check (process_status in ('received','processed','duplicate','error','ignored'))
);

-- ---------- Reference-data mirrors (read-only caches of the test store) ----------
create table if not exists public.ls_outlets (
  id uuid not null, name text, currency text, tax_id uuid, time_zone text,
  raw jsonb, updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint ls_outlets_pkey primary key (id)
);
create table if not exists public.ls_registers (
  id uuid not null, name text, outlet_id uuid, is_open boolean,
  raw jsonb, updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint ls_registers_pkey primary key (id)
);
create table if not exists public.ls_users (
  id uuid not null, username text, display_name text, email text, account_type text,
  is_primary_user boolean, raw jsonb, updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint ls_users_pkey primary key (id)
);
create table if not exists public.ls_taxes (
  id uuid not null, name text, rate numeric, is_default boolean,
  raw jsonb, updated_at timestamptz not null default now(),
  constraint ls_taxes_pkey primary key (id)
);
create table if not exists public.ls_payment_types (
  id text not null, name text, payment_type_id text,
  raw jsonb, updated_at timestamptz not null default now(),
  constraint ls_payment_types_pkey primary key (id)
);
create table if not exists public.lightspeed_products (
  id uuid not null, variant_parent_id uuid, sku text, name text, variant_name text, handle text,
  price numeric, price_including_tax numeric, supply_price numeric, category text, brand text,
  description text, active boolean not null default true, has_inventory boolean, is_composite boolean,
  raw jsonb, updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint lightspeed_products_pkey primary key (id)
);
create table if not exists public.lightspeed_inventory (
  product_id uuid not null, outlet_id uuid not null,
  current_amount numeric, average_cost numeric, reorder_point numeric, reorder_amount numeric,
  updated_at timestamptz not null default now(),
  constraint lightspeed_inventory_pkey primary key (product_id, outlet_id)
);
create table if not exists public.lightspeed_customers (
  id uuid not null, customer_code text, first_name text, last_name text, email text, phone text,
  mobile text, company_name text, customer_group_id uuid,
  raw jsonb, updated_at timestamptz not null default now(), deleted_at timestamptz,
  constraint lightspeed_customers_pkey primary key (id)
);

-- ---------- Sales mirror (for reconciliation reporting) ----------
create table if not exists public.ls_sales (
  id uuid not null,
  source_id text,
  app_order_number text,
  app_quote_number text,
  state text,
  invoice_number text,
  total numeric,
  total_tax numeric,
  customer_id uuid,
  salesperson_user_id uuid,
  outlet_id uuid,
  register_id uuid,
  sale_date timestamptz,
  return_for uuid,
  version bigint,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ls_sales_pkey primary key (id),
  constraint ls_sales_source_id_key unique (source_id)
);

create table if not exists public.ls_reconciliation_runs (
  id bigint generated always as identity,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  kind text not null default 'inventory',
  checked integer default 0,
  mismatches integer default 0,
  fixed integer default 0,
  details jsonb,
  constraint ls_reconciliation_runs_pkey primary key (id)
);

create table if not exists public.ls_config (
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ls_config_pkey primary key (key)
);

-- ---------- RLS ----------
alter table public.ls_connections        enable row level security;
alter table public.ls_oauth_states       enable row level security;
alter table public.ls_ops                enable row level security;
alter table public.ls_request_log        enable row level security;
alter table public.raffi_app_state          enable row level security;
alter table public.raffi_module_chunks      enable row level security;
alter table public.ls_webhook_events     enable row level security;
alter table public.ls_outlets            enable row level security;
alter table public.ls_registers          enable row level security;
alter table public.ls_users              enable row level security;
alter table public.ls_taxes              enable row level security;
alter table public.ls_payment_types      enable row level security;
alter table public.lightspeed_products   enable row level security;
alter table public.lightspeed_inventory  enable row level security;
alter table public.lightspeed_customers  enable row level security;
alter table public.ls_sales              enable row level security;
alter table public.ls_reconciliation_runs enable row level security;
alter table public.ls_config             enable row level security;

-- Read-only policies that exist in the live project (reference mirrors only;
-- tokens/state/ops tables have NO policies -> service-role only).
create policy "anon can read outlets"        on public.ls_outlets            for select using (true);
create policy "anon can read registers"      on public.ls_registers          for select using (true);
create policy "anon can read users"          on public.ls_users              for select using (true);
create policy "anon can read taxes"          on public.ls_taxes              for select using (true);
create policy "anon can read payment types"  on public.ls_payment_types      for select using (true);
create policy "anon can read products"       on public.lightspeed_products   for select using (true);
create policy "anon can read inventory"      on public.lightspeed_inventory  for select using (true);
create policy "anon can read sales mirror"   on public.ls_sales              for select using (true);
create policy "anon can read request log"    on public.ls_request_log        for select using (true);
create policy "anon can read reconciliation" on public.ls_reconciliation_runs for select using (true);

-- ---------- Vault helpers (secret storage for LS_CLIENT_SECRET fallback) ----------
-- These exist in the live project; shown here for completeness.
-- ls_set_secret(name text, secret text) / ls_get_secret(name text) wrap vault.create_secret /
-- vault.decrypted_secrets and are SECURITY DEFINER, EXECUTE revoked from anon/authenticated.
