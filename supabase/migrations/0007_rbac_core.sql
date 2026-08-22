-- ============================================================================
-- RBAC core: profiles + user_roles replace the flat scanner allowlist.
-- Roles: admin · scanner · asset_viewer · dashboard_viewer
-- ============================================================================

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text unique not null,
  full_name  text,
  active     boolean not null default true,
  invited_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role    text not null check (role in ('admin','scanner','asset_viewer','dashboard_viewer')),
  primary key (user_id, role)
);

create index if not exists idx_user_roles_user on public.user_roles (user_id);

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.has_role(want text)
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
      and r.role = want
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role('admin');
$$;

-- Assets writes: scanner or admin (replaces allowlist check)
create or replace function public.is_allowed_scanner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_role('scanner') or public.has_role('admin');
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.user_roles enable row level security;

-- profiles: read your own; admin reads all; admin manages
drop policy if exists "profiles read own or admin" on public.profiles;
create policy "profiles read own or admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles insert admin" on public.profiles;
create policy "profiles insert admin"
  on public.profiles for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "profiles update admin" on public.profiles;
create policy "profiles update admin"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "profiles delete admin" on public.profiles;
create policy "profiles delete admin"
  on public.profiles for delete
  to authenticated
  using (public.is_admin());

-- user_roles: read your own; admin reads and manages all
drop policy if exists "user_roles read own or admin" on public.user_roles;
create policy "user_roles read own or admin"
  on public.user_roles for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "user_roles write admin" on public.user_roles;
create policy "user_roles write admin"
  on public.user_roles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
