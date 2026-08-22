-- ============================================================================
-- Asset Scanner: initial Supabase schema
-- SharePoint becomes a read-only mirror; this database is the source of truth.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Allowed scanner operators (moved from SharePoint "Scanner Access" list)
-- ---------------------------------------------------------------------------
create table if not exists public.allowed_scanners (
  email      text primary key,
  added_by   text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Assets (mirrors the SharePoint asset list fields)
-- ---------------------------------------------------------------------------
create table if not exists public.assets (
  id           uuid primary key default gen_random_uuid(),
  item_id      text unique not null,          -- stable business key (SharePoint ItemId during backfill)
  title        text,
  asset_tag    text,
  asset_type   text,
  model        text,
  serial       text,
  employee     text,
  status       text,
  location     text,
  extra        jsonb not null default '{}'::jsonb,  -- remaining list columns
  graph_item_id text unique,                  -- SharePoint item id, filled by sync worker
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_assets_status   on public.assets (status);
create index if not exists idx_assets_employee on public.assets (employee);
create index if not exists idx_assets_serial   on public.assets (serial);

-- ---------------------------------------------------------------------------
-- SharePoint sync outbox (+ idempotency map)
-- One row per change; Edge Function drains pending/failed rows.
-- ---------------------------------------------------------------------------
create table if not exists public.sharepoint_sync (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid references public.assets(id) on delete set null,
  op            text not null check (op in ('insert','update','delete')),
  status        text not null default 'pending' check (status in ('pending','done','failed')),
  attempts      int  not null default 0,
  last_error    text,
  graph_item_id text,                          -- snapshot (survives asset delete)
  payload       jsonb,                         -- field snapshot for insert/update
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists idx_outbox_undrained
  on public.sharepoint_sync (created_at)
  where status <> 'done';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assets_touch_updated_at on public.assets;
create trigger assets_touch_updated_at
  before update on public.assets
  for each row execute function public.touch_updated_at();

create or replace function public.assets_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pl jsonb;
begin
  if tg_op = 'DELETE' then
    insert into public.sharepoint_sync (asset_id, op, graph_item_id)
    values (old.id, 'delete', old.graph_item_id);
    return old;
  end if;

  pl := jsonb_strip_nulls(jsonb_build_object(
    'item_id',    new.item_id,
    'title',      new.title,
    'asset_tag',  new.asset_tag,
    'asset_type', new.asset_type,
    'model',      new.model,
    'serial',     new.serial,
    'employee',   new.employee,
    'status',     new.status,
    'location',   new.location,
    'extra',      new.extra
  ));

  insert into public.sharepoint_sync (asset_id, op, graph_item_id, payload)
  values (new.id, lower(tg_op), new.graph_item_id, pl);
  return new;
end;
$$;

drop trigger if exists assets_to_outbox_trigger on public.assets;
create trigger assets_to_outbox_trigger
  after insert or update or delete on public.assets
  for each row execute function public.assets_to_outbox();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
create or replace function public.is_allowed_scanner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_scanners
    where email = lower(auth.email())
  );
$$;

alter table public.assets            enable row level security;
alter table public.allowed_scanners  enable row level security;
alter table public.sharepoint_sync   enable row level security;

-- Reads: any signed-in operator
drop policy if exists "authenticated read assets" on public.assets;
create policy "authenticated read assets"
  on public.assets for select
  to authenticated
  using (true);

drop policy if exists "authenticated read allowlist" on public.allowed_scanners;
create policy "authenticated read allowlist"
  on public.allowed_scanners for select
  to authenticated
  using (true);

-- Writes: only allowlisted emails (server-enforced)
drop policy if exists "allowlisted insert assets" on public.assets;
create policy "allowlisted insert assets"
  on public.assets for insert
  to authenticated
  with check (public.is_allowed_scanner());

drop policy if exists "allowlisted update assets" on public.assets;
create policy "allowlisted update assets"
  on public.assets for update
  to authenticated
  using (public.is_allowed_scanner())
  with check (public.is_allowed_scanner());

drop policy if exists "allowlisted delete assets" on public.assets;
create policy "allowlisted delete assets"
  on public.assets for delete
  to authenticated
  using (public.is_allowed_scanner());

-- sharepoint_sync: no policies -> accessible only via service_role (Edge Function)
