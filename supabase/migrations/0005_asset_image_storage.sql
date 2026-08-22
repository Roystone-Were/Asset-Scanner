-- Asset images live in Supabase Storage (public read, allowlisted-scanner write).

insert into storage.buckets (id, name, public)
values ('asset-images', 'asset-images', true)
on conflict (id) do nothing;

drop policy if exists "public read asset images" on storage.objects;
create policy "public read asset images"
  on storage.objects for select
  using (bucket_id = 'asset-images');

drop policy if exists "auth insert asset images" on storage.objects;
create policy "auth insert asset images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'asset-images');

drop policy if exists "auth update asset images" on storage.objects;
create policy "auth update asset images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'asset-images');

drop policy if exists "auth delete asset images" on storage.objects;
create policy "auth delete asset images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'asset-images');
