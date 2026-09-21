-- ============================================================================
-- 0038: data integrity, allocator safety, operational plumbing.
--
-- Everything here came out of the 2026-09-20 audit and is verified against the
-- live project before applying (no off-vocabulary values existed, so the choice
-- guard cannot reject existing rows):
--
--  1. schema_migrations — a ledger. apply-migration.mjs records nothing today,
--     which is exactly how 0030 could report HTTP 201 while its index was never
--     created. From now on "applied" is a row, not a memory.
--  2. Choice validation. status/location/asset_type/department were bare text
--     with no link to app_choices, so every vocabulary drift needed a data
--     migration of its own (0023, 0024, 0031, 0032, 0033, 0034). A BEFORE
--     trigger now refuses values that are not in the admin list, and status
--     gets a default so a direct API insert cannot create a NULL.
--  3. deleted_at joins the audit trigger's tracked columns: binning and
--     restoring an asset wrote nothing to asset_history, so "who binned this"
--     had no answer.
--  4. Allocator: next_asset_item_id() was max(item_id::bigint)+1 with no lock,
--     and because purge hard-deletes rows, the highest id could be handed out
--     again — the new asset then inherited the purged asset's asset_history and
--     asset_events (both keyed by item_id text, no FK). A single-row high-water
--     table plus an advisory lock makes allocation monotonic and race-free.
--  5. asset_events: created_by was whatever the browser sent, and any scanner
--     could rewrite any event row. The trigger stamps the JWT's email and
--     freezes item_id/event_type/created_by/created_at. Closing an issue is
--     still allowed (that is the IT workflow).
--  6. assets_price_or_estimate used `(extra->>'estimate_pending')::boolean`,
--     which raises 22P02 on a junk value ("pending", ""), so a bad key could
--     abort an otherwise valid insert. Replaced with a total expression.
--  7. Indexes for the queries that exist: every page load filters
--     `deleted_at is null`, and the dashboard's event widgets filter by
--     event_type + resolved ordered by event_date. The three single-column
--     indexes (status/employee/serial) are deliberately kept: the app never
--     uses them, but ad-hoc ops SQL does, and at 231 rows they cost nothing.
--  8. Outbox: requeue_failed_sync_rows() set status back to pending but left
--     attempts at the max, so one requeue bought exactly one attempt and the
--     row flipped straight back to failed. It now resets attempts/last_error,
--     and a bounded sweep revives failed rows every 15 minutes until they have
--     had 20 attempts — self-healing without an infinite retry loop.
--  9. Retention: `done` outbox rows accumulated forever (1,567 rows in 4 weeks
--     with no pruning). A monthly cron trims them at 90 days; asset_history is
--     kept indefinitely and can be pruned deliberately with
--     prune_operational_history().
-- 10. admin_audit: identity changes (invite, roles, active, delete, password
--     reset) wrote nothing anywhere, so "who removed whose access, and when"
--     was unanswerable. Service-role writes only, admin read.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Migration ledger
-- ---------------------------------------------------------------------------
create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  note       text
);

alter table public.schema_migrations enable row level security;
drop policy if exists "admin read migrations" on public.schema_migrations;
create policy "admin read migrations"
  on public.schema_migrations for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Choice validation + status default
-- ---------------------------------------------------------------------------
alter table public.assets alter column status set default 'Available';

create or replace function public.assets_guard_choices()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(new.status), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'status' and c.value = btrim(new.status)) then
    raise exception 'Status "%" is not in the admin list (Admin > Lists)', new.status using errcode = '23514';
  end if;
  if coalesce(btrim(new.asset_type), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'asset_type' and c.value = btrim(new.asset_type)) then
    raise exception 'Asset Type "%" is not in the admin list (Admin > Lists)', new.asset_type using errcode = '23514';
  end if;
  if coalesce(btrim(new.location), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'location' and c.value = btrim(new.location)) then
    raise exception 'Location "%" is not in the admin list (Admin > Lists)', new.location using errcode = '23514';
  end if;
  if coalesce(btrim(new.extra ->> 'department'), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'department' and c.value = btrim(new.extra ->> 'department')) then
    raise exception 'Department "%" is not in the admin list (Admin > Lists)', new.extra ->> 'department' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists assets_guard_choices_trigger on public.assets;
create trigger assets_guard_choices_trigger
  before insert or update on public.assets
  for each row execute function public.assets_guard_choices();

-- ---------------------------------------------------------------------------
-- 3. Bin/restore joins the audit trail
-- ---------------------------------------------------------------------------
create or replace function public.assets_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
  cols  jsonb := '{}'::jsonb;
  k     text;
  tracked constant jsonb :=
    '["title","asset_tag","asset_type","model","serial","employee","status","location","deleted_at","extra"]'::jsonb;
begin
  actor := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'service_role'
  );

  if TG_OP = 'INSERT' then
    insert into public.asset_history (item_id, op, changed_by, new_row)
    values (NEW.item_id, 'insert', actor, to_jsonb(NEW));
    return NEW;

  elsif TG_OP = 'UPDATE' then
    for k in select value from jsonb_array_elements_text(tracked) loop
      if to_jsonb(OLD) -> k is distinct from to_jsonb(NEW) -> k then
        cols := jsonb_set(cols, array[k],
          jsonb_build_object('old', to_jsonb(OLD) -> k, 'new', to_jsonb(NEW) -> k));
      end if;
    end loop;
    if cols <> '{}'::jsonb then
      insert into public.asset_history (item_id, op, changed_by, fields, old_row, new_row)
      values (NEW.item_id, 'update', actor, cols, to_jsonb(OLD), to_jsonb(NEW));
    end if;
    return NEW;

  else  -- DELETE
    insert into public.asset_history (item_id, op, changed_by, old_row)
    values (OLD.item_id, 'delete', actor, to_jsonb(OLD));
    return OLD;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Monotonic, race-free item_id allocation
-- ---------------------------------------------------------------------------
create table if not exists public.asset_id_high_water (
  only_row boolean primary key default true check (only_row),
  next_id  bigint not null
);

insert into public.asset_id_high_water (next_id)
select greatest(coalesce(max(item_id::bigint), 0) + 1, 101)
  from public.assets
 where item_id ~ '^[0-9]+$'
on conflict (only_row) do nothing;

alter table public.asset_id_high_water enable row level security;
-- no policies: reached only through the definer allocator below

create or replace function public.next_asset_item_id()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  perform pg_advisory_xact_lock(778899001);   -- one allocator at a time
  update public.asset_id_high_water w
     set next_id = greatest(
           w.next_id + 1,
           (select coalesce(max(a.item_id::bigint), 0) + 1
              from public.assets a where a.item_id ~ '^[0-9]+$'))
   where w.only_row
  returning w.next_id - 1 into n;             -- hand out the value just reserved
  return n::text;
end;
$$;

revoke execute on function public.next_asset_item_id() from public, anon;
grant execute on function public.next_asset_item_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Event attribution + immutable creation facts
-- ---------------------------------------------------------------------------
create or replace function public.asset_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  who    text;
begin
  if TG_OP = 'INSERT' then
    if claims is not null and (claims::jsonb ->> 'role') is distinct from 'service_role' then
      who := claims::jsonb ->> 'email';
      if who is not null then new.created_by := who; end if;   -- never trust the client's claim
    end if;
    return new;
  end if;
  -- updates may close an issue; they may not rewrite what the event was
  new.item_id    := old.item_id;
  new.event_type := old.event_type;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists asset_events_guard_trigger on public.asset_events;
create trigger asset_events_guard_trigger
  before insert or update on public.asset_events
  for each row execute function public.asset_events_guard();

-- ---------------------------------------------------------------------------
-- 6. Total price-or-estimate constraint
-- ---------------------------------------------------------------------------
alter table public.assets drop constraint if exists assets_price_or_estimate;
alter table public.assets
  add constraint assets_price_or_estimate
  check (
    coalesce(nullif(btrim(extra ->> 'purchase_price'), ''), '') <> ''
    or lower(coalesce(extra ->> 'estimate_pending', '')) in ('true', '1', 'yes')
  );

-- ---------------------------------------------------------------------------
-- 7. Indexes for the queries that exist
-- ---------------------------------------------------------------------------
create index if not exists idx_assets_live_item
  on public.assets (item_id) where deleted_at is null;

create index if not exists idx_asset_events_type_resolved
  on public.asset_events (event_type, resolved, event_date desc);

-- ---------------------------------------------------------------------------
-- 8. Outbox retry: manual requeue resets the counter, cron revives failures
-- ---------------------------------------------------------------------------
create or replace function public.requeue_failed_sync_rows()
returns int
language sql
security definer
set search_path = public
as $$
  with r as (
    update public.sharepoint_sync
       set status = 'pending', attempts = 0, last_error = null, processed_at = null
     where status = 'failed'
    returning 1)
  select count(*)::int from r;
$$;

revoke execute on function public.requeue_failed_sync_rows() from public, anon, authenticated;
grant execute on function public.requeue_failed_sync_rows() to service_role;

do $$
begin
  perform cron.unschedule('sharepoint-sync-requeue');
exception when others then null;
end $$;

select cron.schedule('sharepoint-sync-requeue', '*/15 * * * *', $job$
  update public.sharepoint_sync
     set status = 'pending'
   where status = 'failed'
     and attempts < 20
     and coalesce(attempted_at, processed_at, created_at) < now() - interval '30 minutes';
$job$);

-- ---------------------------------------------------------------------------
-- 9. Retention
-- ---------------------------------------------------------------------------
create or replace function public.prune_operational_history(p_outbox_days int default 90, p_audit_days int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  n_out  int;
  n_aud  int := 0;
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not public.is_admin() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  delete from public.sharepoint_sync
   where status = 'done'
     and coalesce(processed_at, created_at) < now() - make_interval(days => greatest(p_outbox_days, 7));
  get diagnostics n_out = row_count;

  if p_audit_days > 0 then
    delete from public.asset_history
     where changed_at < now() - make_interval(days => p_audit_days);
    get diagnostics n_aud = row_count;
  end if;

  return jsonb_build_object('outbox_deleted', n_out, 'history_deleted', n_aud);
end;
$$;

revoke execute on function public.prune_operational_history(int, int) from public, anon;
grant execute on function public.prune_operational_history(int, int) to authenticated;

do $$
begin
  perform cron.unschedule('xana-prune-outbox');
exception when others then null;
end $$;

-- first of the month, 03:10 — done rows older than 90 days
select cron.schedule('xana-prune-outbox', '10 3 1 * *', $job$
  delete from public.sharepoint_sync
   where status = 'done'
     and coalesce(processed_at, created_at) < now() - interval '90 days';
$job$);

-- ---------------------------------------------------------------------------
-- 10. Admin action audit
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit (
  id          bigserial primary key,
  actor_id    uuid,
  actor_email text,
  action      text not null,
  target      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_admin_audit_created on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;
drop policy if exists "admin read admin audit" on public.admin_audit;
create policy "admin read admin audit"
  on public.admin_audit for select
  to authenticated
  using (public.is_admin());
-- writes come from api/admin-users.js with the service-role key (bypasses RLS),
-- so no insert policy exists on purpose.
