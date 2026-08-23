-- ============================================================================
-- Manual-password onboarding: admins create users with an initial password
-- (no invite email needed). Users are forced to change it at first sign-in.
-- ============================================================================

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

-- RLS: users may read + clear their own flag (the forced-change screen);
-- the flag is SET only via service role (api/admin-users.js).
drop policy if exists "profiles self select" on public.profiles;
create policy "profiles self select"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles self update password flag" on public.profiles;
create policy "profiles self update password flag"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());
