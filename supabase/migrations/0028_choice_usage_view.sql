-- ============================================================================
-- 0028: how many assets actually use each choice value.
--
-- The ✕ in /admin -> Lists deletes a dropdown value with no confirmation and
-- no idea what depends on it. Assets survive (there is no FK, they keep the
-- raw string) but the value stops being selectable, and for an asset type its
-- useful_life is gone -- so depreciation silently reverts to the built-in
-- default. This view gives the admin page the counts it needs to warn first.
--
-- Three categories live in columns, two inside extra; the union hides that.
-- security_invoker so the caller's RLS applies (assets SELECT is already open
-- to any authenticated user).
-- ============================================================================

create or replace view public.choice_usage
with (security_invoker = true) as
  select 'asset_type'::text as category, asset_type as value, count(*)::int as n
    from public.assets
   where deleted_at is null and coalesce(asset_type,'') <> ''
   group by asset_type
union all
  select 'status'::text, status, count(*)::int
    from public.assets
   where deleted_at is null and coalesce(status,'') <> ''
   group by status
union all
  select 'location'::text, location, count(*)::int
    from public.assets
   where deleted_at is null and coalesce(location,'') <> ''
   group by location
union all
  select 'department'::text, extra->>'department', count(*)::int
    from public.assets
   where deleted_at is null and coalesce(extra->>'department','') <> ''
   group by extra->>'department'
union all
  select 'region'::text, extra->>'region', count(*)::int
    from public.assets
   where deleted_at is null and coalesce(extra->>'region','') <> ''
   group by extra->>'region';

grant select on public.choice_usage to authenticated;
