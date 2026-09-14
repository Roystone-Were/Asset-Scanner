-- ============================================================================
-- 0034: Drop the unused "Desktop" asset type from the Admin dropdown.
-- Zero live assets use it (all towers are "CPU"; verified 2026-09-14), so
-- this only shrinks the add-form dropdown. Guarded: if a Desktop asset
-- ever appears, the delete is skipped with a NOTICE instead of failing.
-- Idempotent: re-runs delete zero rows once applied.
-- NOTE: USEFUL_LIFE_BY_TYPE.Desktop in js/supabase-client.js stays — it is
-- a depreciation fallback, not a dropdown source, and costs nothing.
-- ============================================================================
do $$
declare
  in_use int;
begin
  select count(*) into in_use
  from public.assets
  where deleted_at is null and asset_type = 'Desktop';
  if in_use > 0 then
    raise notice '0034: % live Desktop assets exist — choice NOT removed.', in_use;
  else
    delete from public.app_choices where category = 'asset_type' and value = 'Desktop';
    raise notice '0034: Desktop choice removed.';
  end if;
end $$;
