-- 0024: fold remaining "Finance" department variants into the canonical
-- "Finance and Admin" (app_choices already only has this one — see 0012).
-- These two slipped in after 0012's cleanup ran, before the detail-card
-- Department field was locked to a dropdown. Confirmed against live data
-- 2026-08-28: Finance and Admin(12) Finance and admin(1) Finance(1)
-- -> Finance and Admin(14).

update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Finance and Admin"')
  where extra->>'department' in ('Finance and admin','Finance');
