-- ============================================================================
-- 0036: Security hardening.
--
-- Verified 2026-09-20 against the live project (pg_proc + public-key probes):
--
--  1. asset_extra_merge is SECURITY DEFINER while the function owner is also
--     the owner of public.assets, and assets is not FORCE ROW LEVEL SECURITY —
--     so the assets UPDATE policy never runs inside it. The file's own comment
--     claimed the opposite. `grant execute ... to authenticated` (0010) is
--     additive to the default PUBLIC grant, and no migration ever revoked it:
--     POST /rest/v1/rpc/asset_extra_merge with the publishable key alone
--     returned HTTP 204. Anyone holding the public key (it ships in the
--     browser bundle) could rewrite any asset's extra — purchase_price,
--     last_verified, image_url, department.
--     Same default-grant exposure on next_asset_item_id (anon) and
--     requeue_failed_sync_rows (anon can re-drive the SharePoint mirror
--     queue). touch_last_seen (0035) is the only function that revoked it.
--
--  2. The asset-images / it-documents SELECT policies are `to public`. The
--     buckets are public by design (ADR-002), but the SELECT policy also
--     governs Storage's object LIST route: an anonymous
--     POST /storage/v1/object/list/it-documents returned the real filenames
--     of the internal IT forms, and /object/list/asset-images returned the
--     item_id folders. Object URLs stay public (that is what <img> needs);
--     listing must not be.
--
--  3. profiles' self-update policy (0009) grants every column, so a
--     deactivated account can PATCH profiles {active:true} and undo 0029's
--     read gate. A BEFORE UPDATE trigger now blocks self-changes to active
--     and email while leaving must_change_password/last_seen to the app.
--
--  4. 0020 restricted the hard DELETE to admins, but the path the UI uses is
--     a soft delete — a plain scanner-writable UPDATE of deleted_at. A
--     BEFORE UPDATE trigger now requires admin for any deleted_at transition.
--
--  5. allowed_scanners still carried a `using (true)` read policy for any
--     authenticated account; 0007 replaced the function that read it, so the
--     policy only leaks the legacy email list. Dropped (table kept: the 0006
--     admin policies and any old tooling still reference it).
--
-- Every guard reads request.jwt.claims and falls through to permissive when
-- the setting is empty (migrations, psql) or when the caller is service_role
-- (api/admin-users.js, the sync worker, scripted backfills) — that is the same
-- split the app already relies on. Failures raise 42501 so they surface as a
-- plain "not permitted" instead of a silent no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extra-merge RPC: keep the definer body, gate the caller explicitly.
-- ---------------------------------------------------------------------------
create or replace function public.asset_extra_merge(p_item_id text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  -- RLS does not apply inside this function (owner-executed DML), so the
  -- role gate the assets UPDATE policy would have provided is spelled out.
  -- Empty claims = migrations/psql (already free to update the table), and
  -- service_role = api/admin-users.js, the sync worker and the scripted
  -- backfills — both keep the merge.
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to edit assets' using errcode = '42501';
  end if;
  update public.assets
     set extra = coalesce(extra, '{}'::jsonb) || p_patch
   where item_id = p_item_id;
end;
$$;

revoke execute on function public.asset_extra_merge(text, jsonb) from public, anon;
grant execute on function public.asset_extra_merge(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Allocator + outbox requeue: no anonymous callers.
-- ---------------------------------------------------------------------------
revoke execute on function public.next_asset_item_id() from public, anon;
grant execute on function public.next_asset_item_id() to authenticated;

revoke execute on function public.requeue_failed_sync_rows() from public, anon, authenticated;
grant execute on function public.requeue_failed_sync_rows() to service_role;

-- ---------------------------------------------------------------------------
-- 2b. Every write helper now also requires an active profile.
--
-- 0029 made *reads* depend on an active profile, but the write helpers never
-- did: is_allowed_scanner() (0007) is "has scanner|admin", and a deactivated
-- account keeps its user_roles rows. So deactivating someone removed their
-- reads and left their writes, which is the opposite of ADR-004's intent.
-- Found live on 2026-09-20: four auth accounts left over from the Aug-22/23
-- harness runs (e2e-test+, pwd-test+, audit5+, del-test+ addresses) have no
-- profiles row at all, so /admin cannot even show them, yet two of them still
-- held `scanner` and could write to assets through PostgREST.
-- ---------------------------------------------------------------------------
create or replace function public.is_allowed_scanner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_app_role() and (public.has_role('scanner') or public.has_role('admin'));
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_app_role() and (public.has_role('admin') or public.has_role('super_admin'));
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_app_role() and public.has_role('super_admin');
$$;

-- Roles belonging to an account with no profile row can never be shown or
-- revoked from /admin (the Users grid is profile-driven) — remove them.
delete from public.user_roles ur
 where not exists (select 1 from public.profiles p where p.id = ur.user_id);

-- ---------------------------------------------------------------------------
-- 3. Storage: public object URLs stay, anonymous listing goes.
-- ---------------------------------------------------------------------------
drop policy if exists "public read asset images" on storage.objects;
drop policy if exists "signed-in read asset images" on storage.objects;
create policy "signed-in read asset images"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'asset-images');

drop policy if exists "public read it documents" on storage.objects;
drop policy if exists "admin read it documents" on storage.objects;
create policy "admin read it documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. profiles: active/email are administrator-managed.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard_self()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  if claims is null or claims = '' then return new; end if;                 -- SQL / migrations
  if (claims::jsonb ->> 'role') = 'service_role' then return new; end if;   -- admin API, worker
  if new.active is distinct from old.active then
    raise exception 'active is managed by an administrator' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'email is managed by an administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_self_trigger on public.profiles;
create trigger profiles_guard_self_trigger
  before update on public.profiles
  for each row execute function public.profiles_guard_self();

-- ---------------------------------------------------------------------------
-- 5. assets: the recycle bin is a lifecycle change, not an edit.
-- ---------------------------------------------------------------------------
create or replace function public.assets_guard_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  if new.deleted_at is not distinct from old.deleted_at then return new; end if;
  if claims is null or claims = '' then return new; end if;
  if (claims::jsonb ->> 'role') = 'service_role' then return new; end if;
  if public.has_role('admin') or public.is_super_admin() then return new; end if;
  raise exception 'only an administrator can move an asset to the recycle bin'
    using errcode = '42501';
end;
$$;

drop trigger if exists assets_guard_lifecycle_trigger on public.assets;
create trigger assets_guard_lifecycle_trigger
  before update on public.assets
  for each row execute function public.assets_guard_lifecycle();

-- ---------------------------------------------------------------------------
-- 6. Legacy allowlist: superseded by roles in 0007, still world-readable to
--    any signed-in account. Drop the read policy; keep the table.
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated read allowlist" on public.allowed_scanners;
