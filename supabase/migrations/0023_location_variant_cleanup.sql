-- 0023: normalize location variants — "location" is a plain text column
-- (unlike "department", which lives in extra JSONB; see 0012 for that
-- pattern). Confirmed against live data 2026-08-28:
--   TRM Dr(6) TRM Drive(3) -> TRM Dr(9)
--   Lumumba Dr(4) Lumumba Drive(4) -> Lumumba Dr(8)
-- app_choices already only has the canonical "TRM Dr"/"Lumumba Dr" entries
-- (no bad rows to clean up there) — these were free-text legacy values
-- predating dropdown enforcement on the Location field.

update public.assets set location = 'TRM Dr' where location = 'TRM Drive';

update public.assets set location = 'Lumumba Dr' where location = 'Lumumba Drive';
