-- ============================================================================
-- 0020: Asset hard-deletes are an admin/super_admin action.
--
-- 0001 gave DELETE to is_allowed_scanner() (= scanner OR admin) and 0016 kept
-- that disjunction, so any scanner JWT could purge rows via PostgREST even
-- though every UI only exposes Delete/Purge to admins. Scanners keep
-- insert/update (field work); only admins and super admins may delete.
-- ============================================================================

drop policy if exists "allowlisted delete assets" on public.assets;
create policy "admin delete assets"
  on public.assets for delete
  to authenticated
  using (public.is_super_admin() or public.has_role('admin'));
