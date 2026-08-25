-- ============================================================================
-- 0021: Storage writes on asset-images require scanner/admin rights.
--
-- 0005 opened insert/update/delete on the bucket to ALL authenticated users
-- despite its own "allowlisted-scanner write" comment. Keep the bucket
-- publicly readable (the apps use getPublicUrl), but gate writes exactly like
-- asset writes: super admin, admin, or scanner.
-- ============================================================================

drop policy if exists "auth insert asset images" on storage.objects;
create policy "scanner insert asset images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );

drop policy if exists "auth update asset images" on storage.objects;
create policy "scanner update asset images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  )
  with check (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );

drop policy if exists "auth delete asset images" on storage.objects;
create policy "scanner delete asset images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );
