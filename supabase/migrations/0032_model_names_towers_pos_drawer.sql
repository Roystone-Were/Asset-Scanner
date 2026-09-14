-- ============================================================================
-- 0032: Consolidate tower, POS printer and cash-drawer model names.
-- Second pass after 0031, per IT review 2026-09-14. Exact-string UPDATEs
-- (idempotent, re-runnable); every change is audited in asset_history with
-- the old value, so any merge below is reversible row by row.
-- Touched (7 rows):
--   towers  — shorthand/suffix variants of the canonical HP names
--   POS     — missing "HP" prefix / missing hyphen only
--   drawer  — "CD36030U00" into majority "CD-3603U-B"
-- Left alone: RP31 vs RP32 (different SKUs), "HP Pro Tower 290" and
-- "290 E PCI" (no G9 marker — generation unconfirmed), "HP TPAD001M" vs
-- "TPA-D005K" (001M vs 005K differ), "CD07I132" (different model), the P24
-- monitor family, and bare-brand models (need physical label reads).
-- Updates flow through the outbox triggers; the SharePoint mirror follows.
-- ============================================================================
update public.assets set model = 'HP Pro Tower 290 G9 Desktop PC'
  where deleted_at is null and model in ('Hp Desktop 290 G9', 'HP Pro Tower 290 G9');

update public.assets set model = 'HP Pro Tower 400 G9 PCI Desktop PC'
  where deleted_at is null and model = 'HP Pro Tower 400 G9 PCI Desktop';

update public.assets set model = 'HP TPA-P001K'
  where deleted_at is null and model = 'TPA-P001K';

update public.assets set model = 'HP TPA-P001M'
  where deleted_at is null and model = 'HP TPAP001M';

update public.assets set model = 'CD-3603U-B'
  where deleted_at is null and model = 'CD36030U00';
