-- 0017: asset_events — human-entered activity log per asset.
-- Complements asset_history (automatic field-change audit) with happenings
-- that aren't a single field edit: repairs, transfers, maintenance, issues.

create table if not exists public.asset_events (
  id          bigserial primary key,
  item_id     text not null,
  event_type  text not null check (event_type in ('issue','repair','maintenance','transfer','note')),
  event_date  timestamptz not null default now(),
  description text not null,
  cost        numeric(12,2),
  resolved    boolean not null default false,   -- open issues show in IT view until closed
  created_by  text,                             -- email of the entering user (set by app)
  created_at  timestamptz not null default now()
);

create index if not exists idx_asset_events_item on public.asset_events (item_id, event_date desc);
create index if not exists idx_asset_events_open on public.asset_events (item_id) where resolved = false and event_type = 'issue';

alter table public.asset_events enable row level security;

drop policy if exists "authenticated read events" on public.asset_events;
create policy "authenticated read events"
  on public.asset_events for select
  to authenticated
  using (true);

-- scanners/admins add events; viewers cannot write
drop policy if exists "scanner insert events" on public.asset_events;
create policy "scanner insert events"
  on public.asset_events for insert
  to authenticated
  with check (public.is_super_admin() or public.is_allowed_scanner());

drop policy if exists "scanner update own-open events" on public.asset_events;
create policy "scanner update events"
  on public.asset_events for update
  to authenticated
  using (public.is_super_admin() or public.is_allowed_scanner())
  with check (public.is_super_admin() or public.is_allowed_scanner());

drop policy if exists "admin delete events" on public.asset_events;
create policy "admin delete events"
  on public.asset_events for delete
  to authenticated
  using (public.is_super_admin() or public.is_admin());
