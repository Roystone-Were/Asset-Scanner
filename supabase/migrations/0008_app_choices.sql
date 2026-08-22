-- ============================================================================
-- Configurable choice lists (admin-managed via /admin -> Lists).
-- Apps read these for dropdowns; new values sync to SharePoint freely now
-- that its Status/Location columns are plain text.
-- ============================================================================

create table if not exists public.app_choices (
  category   text not null check (category in ('asset_type','status','location','region')),
  value      text not null,
  sort_order int  not null default 0,
  primary key (category, value)
);

alter table public.app_choices enable row level security;

drop policy if exists "authenticated read choices" on public.app_choices;
create policy "authenticated read choices"
  on public.app_choices for select
  to authenticated
  using (true);

drop policy if exists "admin manage choices" on public.app_choices;
create policy "admin manage choices"
  on public.app_choices for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed: current built-in lists (idempotent)
-- ---------------------------------------------------------------------------
insert into public.app_choices (category, value, sort_order) values
  ('asset_type','Laptop',1),
  ('asset_type','CPU',2),
  ('asset_type','Monitor',3),
  ('asset_type','Desktop',4),
  ('asset_type','Printer',5),
  ('asset_type','Mouse',6),
  ('asset_type','Keyboard',7),
  ('asset_type','Tablet',8),
  ('asset_type','Phone',9),
  ('asset_type','Server',10),
  ('asset_type','Tower',11),
  ('asset_type','Other',12),
  ('status','In Use',1),
  ('status','Available',2),
  ('status','Retired',3),
  ('status','Left With',4),
  ('status','Lost',5),
  ('location','Syokimau',1),
  ('location','Katani',2),
  ('location','Ruiru',3),
  ('location','Githurai',4),
  ('location','Lumumba Dr',5),
  ('location','TRM Dr',6),
  ('region','Nairobi',1),
  ('region','Kiambu',2)
on conflict (category, value) do nothing;
