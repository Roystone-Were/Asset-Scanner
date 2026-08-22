-- The worker claims outbox rows atomically by setting status='processing';
-- the original check constraint didn't include it.

alter table public.sharepoint_sync
  drop constraint if exists sharepoint_sync_status_check;

alter table public.sharepoint_sync
  add constraint sharepoint_sync_status_check
  check (status in ('pending','processing','done','failed'));
