-- ============================================================================
-- 0022: Hard guard against duplicate asset tags.
-- Two concurrent tagging sessions computed "next free tag" from stale data
-- and collided (7 pairs found 2026-08-25). Enforce uniqueness in the DB so
-- client bugs or offline sessions can never create duplicates again.
-- Partial: recycle-bin rows (deleted_at set) and blank tags are excluded,
-- so restoring or re-tagging never collides with bin contents.
-- ============================================================================
create unique index if not exists assets_live_tag_unique_idx
  on public.assets (lower(asset_tag))
  where deleted_at is null and asset_tag is not null and asset_tag <> '';
