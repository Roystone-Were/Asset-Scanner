-- Fix: delete-op outbox rows must be written BEFORE the asset row disappears,
-- otherwise the FK (sharepoint_sync.asset_id -> assets.id) rejects the insert.

drop trigger if exists assets_to_outbox_trigger on public.assets;

-- insert/update: fire after the row state is final
create trigger assets_to_outbox_after_iu
  after insert or update on public.assets
  for each row execute function public.assets_to_outbox();

-- delete: fire before removal so the FK reference still resolves;
-- ON DELETE SET NULL then detaches it automatically.
create trigger assets_to_outbox_before_d
  before delete on public.assets
  for each row execute function public.assets_to_outbox();
