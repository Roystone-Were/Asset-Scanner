-- IT reference documents (audit checklist, issuance/return forms) live in
-- their own Storage bucket, managed from /admin's new Documents tab.
-- Public read (same convention as asset-images, ADR-002 — avoids signed-URL
-- complexity for non-sensitive files), but write is gated to admins via
-- is_admin() (0007_rbac_core.sql) rather than asset-images' looser
-- "authenticated" — these aren't scanner-uploaded, only admins manage them.

insert into storage.buckets (id, name, public)
values ('it-documents', 'it-documents', true)
on conflict (id) do nothing;

drop policy if exists "public read it documents" on storage.objects;
create policy "public read it documents"
  on storage.objects for select
  using (bucket_id = 'it-documents');

drop policy if exists "admin insert it documents" on storage.objects;
create policy "admin insert it documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'it-documents' and public.is_admin());

drop policy if exists "admin update it documents" on storage.objects;
create policy "admin update it documents"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());

drop policy if exists "admin delete it documents" on storage.objects;
create policy "admin delete it documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());
