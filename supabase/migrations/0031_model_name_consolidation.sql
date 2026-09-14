-- ============================================================================
-- 0031: Consolidate model names that are the same product spelled differently.
-- Typo-level merges only (case, doubled prefix, space-vs-hyphen). Each row
-- below was verified against live data 2026-09-14; affected counts noted.
-- Updates flow through the outbox triggers, so the SharePoint mirror follows
-- automatically like any other edit (9 rows => 9 sync rows, no burst).
-- Ambiguous groups (different SKUs that might be different products:
-- P24 G5 vs P24V vs p24v G6, Pro Tower 290 vs 400 G9 variants, RP31 vs RP32,
-- CD-3603U-B vs CD36030U00, TPA-D vs TPA-P printer variants) are
-- deliberately NOT touched here — they need an IT eyeball, not a migration.
-- Idempotent: every UPDATE matches exact strings, safe to re-run.
-- ============================================================================
update public.assets set model = 'Brother QL-820NWB'
  where deleted_at is null and model = 'Brother-QL820NWB';            -- 1 row: hyphen vs space

update public.assets set model = 'HP Pro Tower 290 G9 Desktop PC'
  where deleted_at is null and model = 'HP HP Pro Tower 290 G9 Desktop PC';  -- 4 rows: doubled "HP HP" prefix

update public.assets set model = 'DELL P2419H'
  where deleted_at is null and model = 'DEL DELL P2419H';              -- 1 row: doubled "DEL DELL" prefix

update public.assets set model = 'HP TPA-L001K'
  where deleted_at is null and model = 'Hp TPA-L001K';                -- 1 row: case

update public.assets set model = 'HP 322pv'
  where deleted_at is null and model = 'HPN HP 322pv';                -- 1 row: stray "N" prefix
