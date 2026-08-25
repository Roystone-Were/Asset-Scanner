-- 0019: recycle bin — soft delete for assets.
-- deleted_at set = asset is in the recycle bin (hidden from views, restorable).
-- Hard purge stays possible for admins. SharePoint mirror treats a
-- soft-deleted asset as deleted until restored.

alter table public.assets add column if not exists deleted_at timestamptz;

-- Mirror + audit semantics on soft delete / restore are handled in the app
-- layer via updateAsset (writes outbox through existing triggers), so no
-- trigger changes needed here.

-- Index for bin queries
create index if not exists idx_assets_deleted on public.assets (deleted_at) where deleted_at is not null;
