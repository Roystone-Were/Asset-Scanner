-- ============================================================================
-- 0033: Consolidate employee-name variants, approved groups only (2026-09-14).
-- Groups A (Deli branches are distinct counters), E (Pharmacy Syokimau) and
-- H (TRM) were explicitly rejected in review — they are NOT touched here.
-- Exact-string UPDATEs (idempotent, re-runnable); every change is audited in
-- asset_history with the old value, so any merge is reversible row by row.
-- Updates flow through the outbox triggers; the SharePoint mirror follows.
-- ============================================================================
-- B: Githurai typos into the correct spelling (2 rows)
update public.assets set employee = 'Githurai Pharmacy'
  where deleted_at is null and employee in ('Githuri Pharmacy', 'Gitthurai Pharmacy');

-- C: liquor typo (1 row)
update public.assets set employee = 'Liquor Store Syokimau'
  where deleted_at is null and employee = 'Liquour Store Syokimau';

-- D: Lumumba Drive majority spelling (4 rows)
update public.assets set employee = 'Lumumba Drive Pharmacy'
  where deleted_at is null and employee in ('Lumumba Dr Pharmacy', 'Lumumba Pharmacy');

-- F: server room typo (1 row)
update public.assets set employee = 'Ruiru Server Room'
  where deleted_at is null and employee = 'Ruiru Server Romm';

-- G: till case/spacing, branch preserved, bare "Till N" untouched (7 rows)
update public.assets set employee = 'Till 1 Ruiru'
  where deleted_at is null and employee = 'till 1 Ruiru';

update public.assets set employee = 'Till 1 Syokimau'
  where deleted_at is null and employee = 'till 1 syokimau';

update public.assets set employee = 'Till 2 Ruiru'
  where deleted_at is null and employee = 'till 2 Ruiru';

update public.assets set employee = 'Till 2 Syokimau'
  where deleted_at is null and employee = 'till 2 sym';

update public.assets set employee = 'Till 3'
  where deleted_at is null and employee = 'till 3';

update public.assets set employee = 'Till 4 Ruiru'
  where deleted_at is null and employee = 'till 4 Ruiru';

update public.assets set employee = 'Till 3 Syokimau'
  where deleted_at is null and employee = 'SyokimauTill 3';
