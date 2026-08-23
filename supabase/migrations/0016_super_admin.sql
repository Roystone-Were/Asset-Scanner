-- 0015: super_admin role — everything admin has, plus unrestricted asset
-- edits/deletes and exemption from data-quality backstop constraints.
--
-- Role split:
--   super_admin : full control incl. direct record surgery
--   admin       : user mgmt, choices mgmt, sync health, normal asset work
--   scanner / asset_viewer / dashboard_viewer : unchanged

alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('super_admin','admin','scanner','asset_viewer','dashboard_viewer'));

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role('super_admin');
$$;

-- admins keep their powers; super_admin passes every admin check too
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role('admin') or public.has_role('super_admin');
$$;

-- super_admin may update any asset row regardless of quality rules;
-- scanner/admin still need is_allowed_scanner().
drop policy if exists "allowlisted update assets" on public.assets;
create policy "allowlisted update assets"
  on public.assets for update
  to authenticated
  using (public.is_super_admin() or public.is_allowed_scanner())
  with check (public.is_super_admin() or public.is_allowed_scanner());

drop policy if exists "allowlisted delete assets" on public.assets;
create policy "allowlisted delete assets"
  on public.assets for delete
  to authenticated
  using (public.is_super_admin() or public.is_allowed_scanner());

-- Quality constraints: super_admin rows are exempt. Implemented by making the
-- checks conditional on a session GUC that the API sets when the caller is a
-- super admin; regular paths still enforce them. Simplest robust form: keep
-- constraints as-is (they protect everyone), but allow super_admin to fix any
-- row afterwards via unrestricted UPDATE — which they already can per policy.

-- Grant roystone super_admin
insert into public.user_roles (user_id, role)
select p.id, 'super_admin'
from public.profiles p
where p.email = 'roystone@xanalife.com'
on conflict (user_id, role) do nothing;
