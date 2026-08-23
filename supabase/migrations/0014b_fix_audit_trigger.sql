-- 0014b: fix the audit trigger — jsonb_object_keys() only works on objects;
-- our tracked-fields list is an array, so iterate via jsonb_array_elements_text.

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
    for k in select value from jsonb_array_elements_text(tracked) loop
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
