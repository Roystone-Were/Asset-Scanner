-- Admin (roystone@xanalife.com) may manage the scanner allowlist from /admin.
-- Everyone else stays read-only (existing select policy).

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(auth.email()) = 'roystone@xanalife.com';
$$;

drop policy if exists "admin manage allowlist" on public.allowed_scanners;
create policy "admin manage allowlist"
  on public.allowed_scanners
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
