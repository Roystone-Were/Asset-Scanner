-- ============================================================================
-- 0035: Real "last seen" presence via profiles.last_seen.
--
-- Admin > Users showed auth.users.last_sign_in_at, which only moves on a
-- fresh sign-in — persistent sessions refresh silently, so daily users looked
-- idle for days. Pages now call touch_last_seen() on load and every 5 min
-- while visible; the admin list prefers last_seen over last_sign_in_at.
-- ============================================================================

alter table public.profiles
  add column if not exists last_seen timestamptz;

create or replace function public.touch_last_seen()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set last_seen = now()
   where id = auth.uid();
end;
$$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;
