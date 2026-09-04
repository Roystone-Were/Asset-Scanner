-- ============================================================================
-- 0029: reading the register requires a role.
--
-- 0001 shipped `create policy "authenticated read assets" ... using (true)`:
-- any signed-in account could pull every asset, price, serial and employee
-- name straight from PostgREST, regardless of role or whether the account had
-- been deactivated. The page gates hid the data; the database did not.
--
-- The predicate is "holds at least one active role" rather than a list of
-- role names, so a role added later is covered without another migration, and
-- deactivating someone in /admin now revokes their read access rather than
-- only hiding the UI.
--
-- Verified before applying: all 6 existing accounts keep access; an account
-- with no roles loses it. The sync worker and admin API use service_role,
-- which bypasses RLS entirely and is unaffected.
-- ============================================================================

create or replace function public.has_app_role()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.user_id = auth.uid()
      and p.active
  );
$$;

-- assets: the register itself
drop policy if exists "authenticated read assets" on public.assets;
create policy "role holders read assets"
  on public.assets for select
  to authenticated
  using (public.has_app_role());

-- asset_history: field-level audit, carries old/new purchase prices
drop policy if exists "authenticated read history" on public.asset_history;
create policy "role holders read history"
  on public.asset_history for select
  to authenticated
  using (public.has_app_role());

-- asset_events: repairs and their costs
drop policy if exists "authenticated read events" on public.asset_events;
create policy "role holders read events"
  on public.asset_events for select
  to authenticated
  using (public.has_app_role());

-- app_choices stays readable to any authenticated user: it is just dropdown
-- vocabulary, and the login/landing flow reads it before roles are resolved.
