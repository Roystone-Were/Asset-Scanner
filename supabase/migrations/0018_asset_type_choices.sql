-- 0018: asset_type choices synced with actual inventory + SharePoint reality.
-- Replaces the stale hard-coded defaults. Existing values are preserved
-- (idempotent re-run); new types added to match live data:
--   Speaker/Mic, POS, UNVR, Switch, Router, Cash Drawer, Scale, Scanner

insert into public.app_choices (category, value, sort_order)
select 'asset_type', v.val, v.so from (values
  ('Laptop',1),('Desktop',2),('CPU',3),('Monitor',4),
  ('Printer',5),('Scanner',6),('Mouse',7),('Keyboard',8),
  ('Phone',9),('POS',10),('Cash Drawer',11),('Scale',12),
  ('Speaker/Mic',13),('Router',14),('Switch',15),('UNVR',16)
) as v(val, so)
where not exists (
  select 1 from public.app_choices c
  where c.category='asset_type' and c.value=v.val
);

-- drop the generic 'Other' from choices if present — types should be specific.
delete from public.app_choices where category='asset_type' and value='Other';
