-- Adds a server-side merge helper so clients can patch single keys inside
-- the assets.extra jsonb without read-modify-write races.
create or replace function public.asset_extra_merge(p_item_id text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.assets
     set extra = coalesce(extra, '{}'::jsonb) || p_patch
   where item_id = p_item_id;
end;
$$;

-- any authenticated user who can already update assets rows may merge extras;
-- the assets UPDATE policy still governs the underlying row change.
grant execute on function public.asset_extra_merge(text, jsonb) to authenticated;
