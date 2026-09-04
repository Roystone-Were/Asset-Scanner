-- ============================================================================
-- 0027: useful life belongs with the asset-type choice, not in the JS bundle.
--
-- USEFUL_LIFE_BY_TYPE in js/supabase-client.js is a hardcoded map, so an admin
-- who adds a type in /admin -> Lists gets the "Other" fallback of 3 years and
-- has no way to correct it without a code change and a deploy. Adding
-- "Camera" needed exactly that (it would otherwise have depreciated 71
-- cameras at 33%/yr instead of 20%).
--
-- The column is nullable: null means "fall back to the JS map", so nothing
-- changes for a type until someone sets a value.
-- ============================================================================

alter table public.app_choices
  add column if not exists useful_life int;

alter table public.app_choices
  drop constraint if exists app_choices_useful_life_sane;
alter table public.app_choices
  add constraint app_choices_useful_life_sane
  check (useful_life is null or (useful_life > 0 and useful_life <= 50));

-- Only asset types carry a useful life; the other categories must stay null.
alter table public.app_choices
  drop constraint if exists app_choices_useful_life_asset_type_only;
alter table public.app_choices
  add constraint app_choices_useful_life_asset_type_only
  check (useful_life is null or category = 'asset_type');

-- Seed from the JS map so the DB and the code agree from day one, and so the
-- values are visible and editable in /admin instead of buried in a bundle.
update public.app_choices c set useful_life = v.years
from (values
  ('Laptop', 3), ('Desktop', 4), ('CPU', 4), ('Monitor', 5),
  ('Printer', 4), ('Scanner', 4), ('Phone', 3),
  ('POS', 5), ('Cash Drawer', 8), ('Scale', 8), ('Speaker/Mic', 5),
  ('Router', 5), ('Switch', 5), ('UNVR', 5), ('Camera', 5), ('TV', 5),
  ('Keyboard', 3), ('Mouse', 2)
) as v(value, years)
where c.category = 'asset_type' and c.value = v.value and c.useful_life is null;
