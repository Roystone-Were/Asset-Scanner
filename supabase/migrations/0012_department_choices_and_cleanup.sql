-- 0012: departments become admin-managed choices; normalize known variants.
-- Canonical list confirmed against live data 2026-08-23:
--   Pharmacy(36) IT(29) Operations(17) Finance and Admin(7+1+1 variants)
--   Back Office(3) Project Management(1) Marketing(1) C-Suite(1)
-- Variants folded: "Finance And Admin"/"Finace And Admin"→"Finance and Admin",
--                  "Operartions"→"Operations", "Information Technology"→"IT"

-- widen the category check to include department
alter table public.app_choices drop constraint app_choices_category_check;
alter table public.app_choices
  add constraint app_choices_category_check
  check (category in ('asset_type','status','location','region','department'));

insert into public.app_choices (category, value, sort_order) values
  ('department','Pharmacy',1),
  ('department','IT',2),
  ('department','Operations',3),
  ('department','Finance and Admin',4),
  ('department','Back Office',5),
  ('department','Project Management',6),
  ('department','Marketing',7),
  ('department','C-Suite',8)
on conflict (category,value) do nothing;

-- normalize variants (exact matches on confirmed live values)
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Operations"')
  where extra->>'department' = 'Operartions';

update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Finance and Admin"')
  where extra->>'department' in ('Finance And Admin','Finace And Admin');

update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"IT"')
  where extra->>'department' = 'Information Technology';
