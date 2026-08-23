-- 0014: full change-history trail for assets.
-- Every INSERT / UPDATE / DELETE on public.assets writes a row here with the
-- acting user (from the JWT) and before/after snapshots. Powers:
--   - "who was given it, then who, then which location" per asset
--   - audit-ready export for KRA/eTIMS hardware
--   - transfer history between branches/users

create table if not exists public.asset_history (
  id          bigserial primary key,
  item_id     text not null,
  op          text not null check (op in ('insert','update','delete')),
  changed_at  timestamptz not null default now(),
  changed_by  text,
  fields      jsonb not null default '{}'::jsonb,  -- {col: {old, new}} for updates
  old_row     jsonb,
  new_row     jsonb
);

create index if not exists idx_asset_history_item on public.asset_history (item_id, changed_at desc);
create index if not exists idx_asset_history_by   on public.asset_history (changed_by);

create or replace function public.assets_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
  cols  jsonb := '{}'::jsonb;
  k     text;
  tracked constant jsonb :=
    '["title","asset_tag","asset_type","model","serial","employee","status","location","extra"]'::jsonb;
begin
  actor := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'service_role'
  );

  if TG_OP = 'INSERT' then
    insert into public.asset_history (item_id, op, changed_by, new_row)
    values (NEW.item_id, 'insert', actor, to_jsonb(NEW));
    return NEW;

  elsif TG_OP = 'UPDATE' then
    for k in select jsonb_object_keys(tracked) loop
      if to_jsonb(OLD) -> k is distinct from to_jsonb(NEW) -> k then
        cols := jsonb_set(cols, '{'||k||'}',
          jsonb_build_object('old', to_jsonb(OLD) -> k, 'new', to_jsonb(NEW) -> k));
      end if;
    end loop;
    if cols <> '{}'::jsonb then
      insert into public.asset_history (item_id, op, changed_by, fields, old_row, new_row)
      values (NEW.item_id, 'update', actor, cols, to_jsonb(OLD), to_jsonb(NEW));
    end if;
    return NEW;

  else  -- DELETE
    insert into public.asset_history (item_id, op, changed_by, old_row)
    values (OLD.item_id, 'delete', actor, to_jsonb(OLD));
    return OLD;
  end if;
end;
$$;

drop trigger if exists assets_audit_trigger on public.assets;
create trigger assets_audit_trigger
  after insert or update or delete on public.assets
  for each row execute function public.assets_audit_trigger();

-- read access: any signed-in user; writes only through the trigger
alter table public.asset_history enable row level security;
drop policy if exists "authenticated read history" on public.asset_history;
create policy "authenticated read history"
  on public.asset_history for select
  to authenticated
  using (true);

grant select on public.asset_history to authenticated;
