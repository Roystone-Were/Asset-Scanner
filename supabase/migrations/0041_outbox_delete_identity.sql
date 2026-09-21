-- ============================================================================
-- 0041: a delete must leave enough behind to find the SharePoint item.
--
-- Found by the sync worker work on 2026-09-20: `sharepoint_sync.asset_id` is
-- NULL on every delete row (31/31 measured live). The FK is
-- `references assets(id) on delete set null`, so even though the BEFORE DELETE
-- trigger (0002) inserts the id while the row still exists, the cascade nulls
-- it a moment later. When the asset also had no `graph_item_id` — a hard delete
-- racing the create's write-back, or a row whose mirror id was cleared by a
-- 404 self-heal — the worker had nothing left to look the SharePoint item up
-- by, and the orphan stayed in the list forever. reconcile-mirror.mjs finds
-- four such items in production today (#134, #135, #136, #137).
--
-- The delete branch therefore snapshots the identifiers into `payload`, which
-- has no FK and survives the cascade: `asset_id` (the uuid the SharePoint item
-- is stamped with, `SupabaseId`) and `item_id` (the business key the ops
-- queries and the residue cleanup already use).
-- ============================================================================

create or replace function public.assets_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pl jsonb;
begin
  if tg_op = 'DELETE' then
    -- asset_id is nulled by the FK right after this row is written, so the
    -- identity travels in payload where nothing can clear it
    insert into public.sharepoint_sync (asset_id, op, graph_item_id, payload)
    values (null, 'delete', old.graph_item_id,
            jsonb_build_object('asset_id', old.id, 'item_id', old.item_id));
    return old;
  end if;

  pl := jsonb_strip_nulls(jsonb_build_object(
    'asset_id',   new.id,
    'item_id',    new.item_id,
    'title',      new.title,
    'asset_tag',  new.asset_tag,
    'asset_type', new.asset_type,
    'model',      new.model,
    'serial',     new.serial,
    'employee',   new.employee,
    'status',     new.status,
    'location',   new.location,
    'extra',      new.extra
  ));

  insert into public.sharepoint_sync (asset_id, op, graph_item_id, payload)
  values (new.id, lower(tg_op), new.graph_item_id, pl);
  return new;
end;
$$;
