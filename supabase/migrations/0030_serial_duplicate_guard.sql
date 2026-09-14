-- ============================================================================
-- 0030: Hard guard against duplicate serial numbers.
-- Genuine duplicates exist in the wild (2026-09-14: "312023090012" on XL-97
-- + XL-99, "9cp541rlnv" on XL-17 + XL-94, "xl-98" on XL-134 + XL-172), and
-- the add form never checked, so a second entry silently stole the first
-- asset's scan identity. Enforce uniqueness in the DB so client bugs or
-- concurrent sessions can never create new duplicates.
-- Partial: recycle-bin rows (deleted_at set), blanks and placeholder serials
-- ("0000", "-", "n/a" — "to be added later", 31 rows on 2026-09-14) are
-- excluded, matching Xana.isPlaceholderSerial in scanner-app/logic.js.
-- That list and this one must stay in sync.
-- Serial-vs-tag collisions (a serial matching another asset's tag, e.g.
-- XL-171's serial "XL-94") are a scan-routing problem, not a serial-dupe
-- problem: tags win in findAssetByCode, so no index can express it. Those
-- stay a frontend block in assets/index.html (serialCollisionText).
-- If genuine dupes still exist, the index build is SKIPPED with a NOTICE
-- (never a failed migration run): resolve them, then re-run this file —
-- `if not exists` makes the re-run a no-op once clean.
-- ============================================================================
do $$
declare
  dup_count int;
  dup_list text;
begin
  select count(*), string_agg(s, ', ' order by s) into dup_count, dup_list
  from (
    select lower(trim(serial)) s
    from public.assets
    where deleted_at is null
      and serial is not null
      and trim(serial) <> ''
      and lower(trim(serial)) not in ('0000', '-', 'n/a')
    group by lower(trim(serial))
    having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise notice '0030: % duplicate serial groups still exist (%), resolve them first — index NOT created. Re-run this migration after cleanup.', dup_count, dup_list;
  else
    create unique index if not exists assets_live_serial_unique_idx
      on public.assets (lower(trim(serial)))
      where deleted_at is null
        and serial is not null
        and trim(serial) <> ''
        and lower(trim(serial)) not in ('0000', '-', 'n/a');
    raise notice '0030: assets_live_serial_unique_idx created.';
  end if;
end $$;
