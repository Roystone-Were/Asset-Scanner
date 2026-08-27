# ADR-002: Asset photos in Supabase Storage `asset-images` + `extra.image_url`

## Status
Accepted — live 2026-08-26 (`0005`, `0021`, `0010`, `js/supabase-client.js` `748681c`)

## Date
2026-08-26

## Context
Staff needed visual verification — a photo of the asset (printer, POS, CPU) to confirm tag/serial on a crowded floor. Requirements:

- Photo captured on floor (mobile camera) or add-sheet file picker, stored with asset, shown in detail card hero.
- No SharePoint attachment — SP list attachments are Graph-heavy and throttled; Supabase Storage is cheaper and already auth-integrated.
- Offline: photo can be taken offline and synced? v1: online-only (dataUrl → blob → upload), offline queued as `extra` patch on next online.

## Decision
* Bucket `asset-images` (`0005_asset_image_storage.sql`): `id='asset-images'`, `public=true`, `SELECT` public, `INSERT/UPDATE/DELETE` gated (`0021_storage_scanner_writes.sql`) to `is_super_admin() OR is_allowed_scanner()` — i.e. `scanner, admin, super_admin`. Viewer roles cannot write.
* Client: `uploadAssetImage(itemId, dataUrl, fileName)` — `fetch(dataUrl).blob()` → `storage.from('asset-images').upload(path, blob, {contentType, upsert:true})` where `path = {item_id}/{sanitisedFileName}` → `getPublicUrl(path)` → `attachAssetImage(itemId, url)` → `rpc asset_extra_merge(p_item_id, p_patch={image_url:url})` (`0010`). `extra.image_url` read via `enrichAsset` (`str(extra.image_url)`) → `showDetail` hero `<img class=detail-hero src=...>` + `Add image / Change image` button (scanner/admin only).
* Add-sheet: `pendingImage` dataUrl → on `Save Asset` after `insertAsset` loop, `if(pendingImage&&created) upload+attach` (toast on fail).
* Detail card: same path via `detailImageInput` file picker.

## Alternatives Considered

### Store image as base64 in `assets.extra`
- Pros: Single row, no storage bucket.
- Cons: `extra` JSONB bloat (400 KB × 144 ≈ 58 MB in JSON), slow queries, no CDN, RLS still needed.
- Rejected: Storage is for blobs.

### SharePoint list attachments
- Pros: Keeps SP as mirror complete.
- Cons: Graph attachment API is chatty, throttled, and SP still read-only mirror — would need second outbox.
- Rejected: Keep SP mirror simple (list columns only).

### Private bucket + signed URLs
- Pros: More secure.
- Cons: Dashboard would need signed-URL refresh on every load; hero `<img>` would need auth header — complex for public `getPublicUrl` use.
- Rejected: Public read is acceptable — photos are internal asset shots, not sensitive; RLS on writes is the control.

## Consequences
+ Full-width hero (`max-height 240px`, `280px` ≥900px, `object-fit:cover`, `border-radius:12px`) — visible on phone and desktop.
+ `asset_extra_merge` avoids read-modify-write race for `image_url`.
+ 0 assets had `image_url` at deploy — backfill is manual (floor team re-photo).
- Large dataUrls (5 MB+) `fetch(dataUrl).blob()` may OOM on low-end phones — limit to <5 MB, 400 KB target (compress on client in v2?).
- Viewer-only users see hero but cannot upload — correct per policy.

## Verification
* `select count(*) from storage.buckets where id='asset-images'` → 1 public.
* `select policyname from pg_policies where tablename='objects'` → `public read`, `scanner insert/update/delete`.
* Live query 2026-08-26: `select count(*) where extra->>'image_url'<>''` → 0 — feature live, data pending.
* Manual: `/assets` → asset → **Add image** → pick file → `Uploading… → ✓ Saved` → hero appears → `select extra->>'image_url'` has `https://irqrnyixizzorvfmtvag.supabase.co/storage/v1/object/public/asset-images/121/...jpg`.

## References
* `supabase/migrations/0005_asset_image_storage.sql`, `0021_storage_scanner_writes.sql`, `0010_asset_extra_merge.sql`
* `js/supabase-client.js` `uploadAssetImage`, `attachAssetImage`, `enrichAsset`
* `assets/index.html` `detail-hero`, `pendingImage`, `detailImageInput`
