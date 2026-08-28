# Xana Asset System — What This App Does

**Version:** Live `xana-assets.vercel.app` — 2026-08-26  
**For:** CEO (page 1–2) + IT Manager (page 3–7) — one document, two depths  
**One line:** One app that registers, verifies, tracks, and reports every company asset — live from Supabase, mirrored to the SharePoint list you already open.

---

## For the CEO — in plain language

### Why it exists
Every laptop, printer, POS, monitor, and cash drawer the company owns has a tag, a serial, an owner, a location, and a value that drops over time. Before, that lived in a SharePoint list that was slow on the floor, had no check-in proof, and no audit trail. This app fixes that without asking staff to learn a new list — SharePoint stays as a read-only view, the app is the master.

### Who uses it

| Person | What they do in the app | Example |
|--------|------------------------|---------|
| **Floor / Store staff (Scanner)** | Scan a barcode, see the asset, change Status/Location/Employee, stamp **✓ Verify**, add a photo | Ruiru stock-take: scan `MICL0045` → card shows Lenovo L13, Serial `PW0M…`, `In Use` → `✓ Verify` |
| **IT / Admin** | Everything Scanner does + invite users, set roles, edit dropdowns (Type, Department…), delete/restore, see sync health | Invite `ada@xanalife.com` as `asset_viewer` → she can view but not edit |
| **Viewer (asset_viewer)** | Search and open any asset, see history, cannot edit | Finance checks `Purchase Price` without risking edits |
| **Exec (dashboard_viewer)** | Opens `/dashboard` — KPIs, book value, replacement due — no register access needed | CEO opens Dashboard → sees 144 assets, KES 2.18M purchase value, 19 unverified |
| **System (offline)** | Works without signal — last fetch is cached, edits queue and sync when online | Syokimau floor with no Wi-Fi: scans still work, `⏳ N offline changes` badge shows |

### What you can do — the 6 jobs the app handles

1. **Register** — The full inventory. Search by tag/serial/model/employee, filter by Type/Location/Status (funnel), sort any column (natural sort: `XL-2 < XL-10 < XL-100`), page 30 at a time. Tap a row for the detail card.
2. **Detail card** — The truth for one asset: Tag, Type, Model, Serial, Department, Employee, Location, Status, Condition, Purchase Date/Price, Book Value, Dep Status, Useful Life, Warranty, Last Verified. Tap any value to edit it (saves instantly and mirrors to SharePoint). Hero photo at top when present.
3. **People** — Offboarding. Search an employee → see all their assets → **Mark all returned** (Status → `Available`, Employee cleared — one tap).
4. **Scan** — Built into `/assets`. Phone camera (torch/zoom when supported) or USB wedge scanner. **Walk mode** (`W`) — continuous, 1.5s dedup, green/red flash + beep + vibrate + counters (like a checkout counter). Scans that match Tag or Serial open the card and stamp `Last Verified / By`.
5. **Dashboard** — Exec view from the same live data: total assets, purchase value, book value, fully depreciated, pending invoices, replacement due, idle stock, lost assets, by Status/Type/Location/Department, health and finance grids. No separate export — data is live.
6. **Admin** — Invite users (email OTP or password), set 4 roles, activate/deactivate, manage dropdown choices (so `Add Asset → Type` never has stale options), and see **Sync health** (how many rows still mirroring to SharePoint).

All of it works on phone and on desktop (≥768 px wider card, two-column fields, `W` / `/` / `Esc` shortcuts). No separate barcode column — the printed label encodes Tag or Serial, both are matched.

---

## For the IT Manager — functional detail

### 1. App map

| Route | File | Who can open | What it does |
|-------|------|--------------|--------------|
| `/` | `index.html` | anyone signed in | Chooser: **Assets** vs **Dashboard** vs **Admin** (role-filtered). |
| `/assets` | `assets/index.html` | `asset_viewer`, `scanner`, `admin`, `super_admin` | Register (table + filters + pagination), detail card, people view, scan sheet, add sheet (single + bundled). |
| `/dashboard` | `summary/index.html` | `dashboard_viewer`, `admin`, `super_admin` | KPIs, depreciation, health, by-* breakdowns — computed client-side from `listAssetsDetailed()`. |
| `/admin` | `admin/index.html` | `admin`, `super_admin` | Users, `app_choices`, `sharepoint_sync` health. |
| `/login` | `login/index.html` | public | Single sign-in (OTP + password), `must_change_password` flow, `landingFor()` redirect. |
| `/scan` | `vercel.json` 301 | — | Redirects to `/assets`. |

`vercel.json` routes those four, plus `lib/` vendored libs.

### 2. Register — how it works

* **Load:** `XanaSupabase.listAssetsDetailed()` → `SELECT item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra WHERE deleted_at IS NULL` → `enrichAsset(row)` — computes `bookValue`, `depStatus`, `usefulLife`, `ageYears`, `warrantyMonths` from `extra.purchase_date/price/estimate_pending/warranty_months`. `extra.image_url` → `it.imageUrl` → hero `<img class=detail-hero>` when present.
* **Filter/sort:** `q` (lower-cased hay `tag+serial+model+employee+type`), `colFilters{type,status}` via funnel popovers (`distinctValues`), `sortKey/sortDir` with `localeCompare(...,{numeric:true})` for natural sort, `currentPage*PAGE_SIZE` slice.
* **Detail card (`showDetail(it)`):** hero if `imageUrl`, grid of `editrow` (each `data-edit="SerialNumber|Asset|Model|Department|EmployeeName|Location|Status|Condition|PurchaseDate|PurchasePrice|WarrantyMonths"`), `Book Value` (teal), `Dep Status`, `Warranty` (`warrantyInfo` → expiry vs today), `Last Verified` (`fmtWhen`). Actions: **Scan again**, **Clone** (prefills add form with next free `XL-N`), **✓ Verify** (scanner/admin only → `verifyAsset` → `LastVerified/By` + `refreshVerifiedRow`), **History**, **Log event**, **Close**, **Delete** (admin only → `deleteAsset` soft-delete). Inline edit: tap `editrow` → `beginEdit` → `updateAsset(id,{Field:val})`.
* **Clone:** `cloneIntoForm(it)` — copies shared `Status,Location,Employee,Department,Condition` etc., leaves `Tag`/`Serial` blank, suggests next `XL-N`.
* **Pagination:** 30/page, `Prev/Next`, `Showing 1–30 of N`.
* **People view:** `Xana.groupPeopleEnriched(allItems)` → `search` filter → `Mark all returned` loops `updateAsset(id,{Status:"Available",EmployeeName:""})` + `logTransfer`.

### 3. Add asset — single + bundled

* **Sheet:** `addSheet` (`#addTag, #addSerial*, #addModel, #addType, #addStatus, #addLocation, #addEmployee, #addDept*, #addCondition, #addPDate, #addPrice(*), #addPriceEstimate, #addWarrantyMonths`, Image drop, Bundled toggle).
* **Required:** `Tag` (unique, checked `allItems.some(tag.toLowerCase)` + DB `unique_asset_tag`), `Serial`, `Department`, `Price` or `estimate pending`. `Tag` is user-entered, never auto-generated.
* **Image:** `addImage` file input → `FileReader.readAsDataURL` → `pendingImage` (dataUrl), `pendingImageName`, `imgPreview`/`imgName`. On `Save` after `insertAsset` loop: `uploadAssetImage(created.id, pendingImage, name)` → `storage.from('asset-images').upload(path, blob, {upsert:true})` → `getPublicUrl` → `attachAssetImage(created.id, url)` → `asset_extra_merge({image_url:url})`.
* **Bundled:** `addBundle` checkbox → `bundleRows` (`BUNDLE_ROW_BP {Monitor:2300,Keyboard:400,Mouse:300}` + `TOWER_BP 7000` of total) → `bundleRowHTML` (Type/Tag/Serial/Model/Price), `nextBundleTags` (max `XL-N` + taken), `allocateBundlePrices` (non-dirty rows renormalise over pool, dirty rows untouched), `updateBundleSum` (allocated vs total, over/under). Save builds `components` array, tower books residual `total - rowSum`, shared fields (`Status,Location,Employee,Department,Condition,PurchaseDate,EstimatePending,WarrantyMonths`) applied to each.
* **Post-save:** `pendingImage=null`, clear form, `resetBundle`, `closeAdd`, `load()`.

Existing asset photo: detail card **Add image / Change image** (scanner/admin) → same `upload+attach` → hero insert/replace, `found.imageUrl=url`, `load()` in 800 ms.

### 4. Scan

* **Camera:** `html5-qrcode` (`html5-qrcode.min.js`), `torch`/`zoom` chips if `track.getCapabilities` reports them (iOS none).
* **Walk mode:** `Walk` button → `isWalk=true`, counters `hit/miss`, stay-open camera, `1.5s` dedup of in-frame barcode, no input refocus while camera runs (keyboard doesn't cover view). Normal = one-shot.
* **Wedge (USB):** global `keydown` burst detector `classifyKeyBurst` (printable, gaps ≤80 ms, `Enter` terminator) → `handleScanHit(text)` → same lookup as camera. Focused input owns its `Enter` (no double).
* **Lookup:** `hay = tag+" "+serial+" "+model+" "+employee+" "+type` lower-cased, cleaned barcode → `offlineLookup` on `xana_data_cache_v1` if `isOfflineish` (offline / TypeError / token redirect) → banner `📴 Offline`, else live `listAssetsDetailed` filter. Hit → `writeFields({LastVerified:now, LastVerifiedBy:email})` + green flash/beep/vibrate; miss → red + `Add-asset` offer.
* **History/write queue:** `writeFields` → direct `PATCH` when online else merged per-item `xana_write_queue_v1` (50 cap) flushed on `load` + `online` (4xx dropped). Badge `⏳ N`.
* **Shortcuts:** `W` (walk), `/` (focus), `Esc` (exit walk) — cold-stream guard 400 ms so `W` inside a wedge burst doesn't fire.

### 5. Dashboard (`/dashboard` / `summary/`)

* No server `api/summary.js` anymore — `XanaSupabase.computeSummary(enriched)` ports it client-side. KPIs: total, purchase value (sum `purchasePrice`), book value (sum `bookValue`), fully depreciated, pending, expensed this year (`purchasePrice/usefulLife`), replacement due (`fully_dep OR age+1 >= usefulLife`), idle stock (`Available` or no employee), lost, byStatus/byType/byLocation/byDepartment. Donut `donut-seg` stroke-dash draw, bars `bar-fill` transition, `rise` stagger. Dark/light via `xana_theme`.

### 6. Admin

* **Users:** `api/admin-users.js` (`list/invite/set_roles/set_active/delete`) — verifies caller JWT + `is_admin()` server-side; `invite` creates user with `must_change_password`. Roles: `super_admin` > `admin` > `scanner` > `asset_viewer`/`dashboard_viewer`.
* **Lists:** `app_choices` (`category,value,sort_order`) — seeded `asset_type, status, location, region, department`. Fills `addType/addDept/addStatus/addLocation`.
* **Sync health:** `sharepoint_sync` table (`op,payload,status,attempts,last_error,graph_item_id`) — shows `pending/failed`, `Requeue` via `requeue_failed_sync_rows()`.

### 7. Data & sync

* **Supabase** `irqrnyixizzorvfmtvag` — `assets`, `asset_history`, `asset_events`, `sharepoint_sync`, `app_choices`, `user_roles`, `profiles`, `allowed_scanners`, storage `asset-images`.
* **Triggers:** `assets_to_outbox_*` → `sharepoint_sync` pending; `assets_audit_trigger` (`tracked = title,asset_tag,asset_type,model,serial,employee,status,location,extra`); `asset_extra_merge` RPC merges `extra` without wipe.
* **Sync:** `pg_net` immediate `POST` to `https://xana-assets.vercel.app/api/sharepoint-sync` (header `SYNC_ACCESS_KEY`) + `pg_cron sharepoint-sync-retry` `*/5`. Worker claims `processing`, stale reset, 429/5xx backoff, `SupabaseId` indexed `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`.
* **Auth:** `supabase-js` `persistSession`, `detectSessionInUrl`, `sanitizeAuthHash` for `#error`, `myRoles()`, `landingFor()`, `applyRoleNav()`.

### 8. Offline, PWA-ish

* `localStorage` `xana_data_cache_v1` (last successful `listAssetsDetailed`), `xana_write_queue_v1`, `xana_theme`. No service worker — rely on Vercel cache + localStorage.

### 9. What it deliberately does not do

* No SharePoint write from UI — mirror is read-only.
* No separate `Barcode` column — label encodes Tag/Serial.
* No PDF label generator in-app — `labels/` is backup, staff scan vendor barcodes.
* No private bucket signed URLs — public read is intentional for `<img>` without auth header.

---

*This document describes functionality, not issues. For issues fixed 2026-08-26 see `docs/decisions/ADR-003*` and for CEO/IT handoff see `CEO_Executive_Briefing_2026-08-26.md` / `IT_Manager_Handoff_2026-08-26.md`.*
