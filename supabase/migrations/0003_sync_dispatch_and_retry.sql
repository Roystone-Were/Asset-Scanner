-- ============================================================================
-- Phase 4: outbox -> sync worker wiring
--  * pg_net fires the worker on every new outbox row (near-real-time)
--  * pg_cron re-drives pending/failed rows every 5 minutes (retry safety net)
--  * app_config holds the worker URL + key (locked down, postgres-only)
-- ============================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- ---------------------------------------------------------------------------
-- Config (worker URL + shared key). No RLS policies => only postgres/service_role.
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;

insert into public.app_config (key, value) values
  ('sync_worker_url', 'https://REPLACE-WITH-YOUR-VERCEL-DOMAIN/api/sharepoint-sync'),
  ('sync_worker_key', 'REPLACE-ME')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- attempted_at column for stale-claim recovery
-- ---------------------------------------------------------------------------
alter table public.sharepoint_sync
  add column if not exists attempted_at timestamptz;

-- ---------------------------------------------------------------------------
-- Near-real-time dispatch: every new outbox row pokes the worker immediately.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_sync_row()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url text;
begin
  select value into v_url from public.app_config where key = 'sync_worker_url';
  if v_url is null or v_url like '%REPLACE%' then
    return new; -- not wired yet; cron/manual drain will pick it up later
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key',   (select value from public.app_config where key = 'sync_worker_key')
    ),
    body    := jsonb_build_object('ids', jsonb_build_array(new.id)),
    timeout_milliseconds := 8000
  );
  return new;
end;
$$;

drop trigger if exists sharepoint_sync_dispatch on public.sharepoint_sync;
create trigger sharepoint_sync_dispatch
  after insert on public.sharepoint_sync
  for each row execute function public.dispatch_sync_row();

-- ---------------------------------------------------------------------------
-- Retry sweep: drains everything still pending/failed every 5 minutes.
-- ---------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('sharepoint-sync-retry');
exception when others then null;
end $$;

select cron.schedule(
  'sharepoint-sync-retry',
  '*/5 * * * *',
  $job$
  select extensions.net.http_post(
    url     := (select value from public.app_config where key = 'sync_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key',   (select value from public.app_config where key = 'sync_worker_key')
    ),
    body    := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 10000
  )
  $job$
);

-- ---------------------------------------------------------------------------
-- Ops helper: requeue all failed rows (e.g. after fixing Graph credentials)
-- ---------------------------------------------------------------------------
create or replace function public.requeue_failed_sync_rows()
returns int
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.sharepoint_sync
    set status = 'pending'
    where status = 'failed'
    returning 1
  )
  select count(*) from upd;
$$;

grant execute on function public.requeue_failed_sync_rows() to service_role;
