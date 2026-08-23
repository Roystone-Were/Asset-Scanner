-- item_id is TEXT, so client-side "ORDER BY item_id DESC LIMIT 1" sorts
-- alphabetically ('99' > '121') and hands out ids that already exist.
-- Allocate the next id atomically server-side instead: numeric max + 1.

create or replace function public.next_asset_item_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select (coalesce(max(item_id::bigint), 100) + 1)::text
  from public.assets
  where item_id ~ '^[0-9]+$'
$$;

grant execute on function public.next_asset_item_id() to authenticated;
