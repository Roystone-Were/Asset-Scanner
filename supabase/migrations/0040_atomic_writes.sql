-- ============================================================================
-- 0040: two write choke points that had no transaction.
--
-- 1. set_user_roles(p_user_id, p_roles) — the admin API replaced a user's roles
--    with DELETE-then-INSERT fired per checkbox. Two ticks in quick succession
--    could land out of order (a role the admin just granted silently dropped
--    while its box stayed ticked), and any failure between the two calls left
--    the account with no roles at all — with 0029/0036 that is no read access
--    and no write access. One statement, one transaction, validated against the
--    same five role names the DB check constraint allows.
--
-- 2. update_asset(p_item_id, p_row, p_extra) — the browser wrote an edit as two
--    round trips: the extra merge RPC first, then a PostgREST PATCH of the
--    columns. If the second failed (RLS, constraint, network) the caller saw a
--    failure while the extra change was already durable, so the rolled-back
--    cell on screen disagreed with the stored row. One call now does both.
--    RLS does not apply inside a SECURITY DEFINER body, so the role gate the
--    assets UPDATE policy would have provided is spelled out — same pattern as
--    0036's asset_extra_merge — and the lifecycle/choice/audit/outbox triggers
--    still fire on the resulting UPDATE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Atomic role replacement (service role only: it is the admin API's job)
-- ---------------------------------------------------------------------------
create or replace function public.set_user_roles(p_user_id uuid, p_roles text[])
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed constant text[] := array['scanner','asset_viewer','dashboard_viewer','admin','super_admin'];
  wanted  text[] := coalesce(p_roles, '{}');
  r       text;
  result  text[];
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'no profile row for %', p_user_id using errcode = '23503';
  end if;
  foreach r in array wanted loop
    if not (r = any(allowed)) then
      raise exception 'unknown role "%"', r using errcode = '22023';
    end if;
  end loop;

  delete from public.user_roles
   where user_id = p_user_id
     and role <> all(wanted);

  insert into public.user_roles (user_id, role)
  select p_user_id, unnest(wanted)
  on conflict do nothing;

  select coalesce(array_agg(role order by role), '{}') into result
    from public.user_roles where user_id = p_user_id;
  return result;
end;
$$;

revoke execute on function public.set_user_roles(uuid, text[]) from public, anon, authenticated;
grant execute on function public.set_user_roles(uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 2. One-transaction asset edit
-- ---------------------------------------------------------------------------
create or replace function public.update_asset(
  p_item_id text,
  p_row     jsonb default '{}'::jsonb,
  p_extra   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  cols   text;
  n      int;
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to edit assets' using errcode = '42501';
  end if;

  if p_item_id is null or btrim(p_item_id) = '' then
    raise exception 'p_item_id is required' using errcode = '22023';
  end if;

  -- only real columns, only those the caller actually sent (a JSON null means
  -- "clear this field", which is why nothing is coalesced against the old value)
  select string_agg(format('%I = r.%I', k, k), ', ')
    into cols
    from jsonb_object_keys(coalesce(p_row, '{}'::jsonb)) as k
   where k in ('title','asset_tag','asset_type','model','serial','employee',
               'status','location','deleted_at','graph_item_id');

  if cols is not null then
    execute format(
      'update public.assets a
          set %s
        from jsonb_populate_record(null::public.assets, $1) r
       where a.item_id = $2', cols)
      using coalesce(p_row, '{}'::jsonb), p_item_id;
    get diagnostics n = row_count;
  else
    select count(*)::int into n from public.assets a where a.item_id = p_item_id;
  end if;

  if p_extra is not null and p_extra <> '{}'::jsonb then
    update public.assets
       set extra = coalesce(extra, '{}'::jsonb) || p_extra
     where item_id = p_item_id;
    get diagnostics n = row_count;
  end if;

  return jsonb_build_object('updated', coalesce(n, 0));
end;
$$;

revoke execute on function public.update_asset(text, jsonb, jsonb) from public, anon;
grant execute on function public.update_asset(text, jsonb, jsonb) to authenticated;
grant execute on function public.update_asset(text, jsonb, jsonb) to service_role;
