-- ============================================================================
-- 0039: storage privacy and limits.
--
-- Both buckets were created `public = true` with no size or MIME limits
-- (0005, 0025). Object URLs are still served without a session when the bucket
-- is public, so anonymous listing was only half the leak 0036 closed:
--
--  * it-documents was public *and* listable: an anonymous
--    POST /storage/v1/object/list/it-documents returned the real filenames of
--    the internal IT forms (verified 2026-09-20). It is now private — the admin
--    page reads it through short-lived signed URLs (js/supabase-client.js
--    listItDocuments) instead of getPublicUrl.
--  * asset-images stays public on purpose: <img src> on the detail card needs a
--    session-free URL (ADR-002), and its paths are per-asset folders. It gains
--    a size cap and an image-only MIME list so a scanner cannot publish an HTML
--    document into a world-readable bucket.
-- ============================================================================

update storage.buckets
   set public = false
 where id = 'it-documents';

update storage.buckets
   set file_size_limit = 10485760,   -- 10 MB after client-side compression
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']
 where id = 'asset-images';

update storage.buckets
   set file_size_limit = 26214400,   -- 25 MB: forms, checklists, spreadsheets
       allowed_mime_types = array[
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/csv',
         'text/plain',
         'image/jpeg',
         'image/png'
       ]
 where id = 'it-documents';

-- read stays admin-only (0036); signed URLs are minted for a caller who passes
-- that policy, so no extra policy is needed here.
drop policy if exists "admin read it documents" on storage.objects;
create policy "admin read it documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());
