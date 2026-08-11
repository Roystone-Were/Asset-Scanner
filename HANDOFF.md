# Xana Asset Lookup & SharePoint List Modernization — Handoff Notes

> Purpose: give another AI agent (or engineer) full context to continue this work.
> Last updated: August 2026 (session on the user's Windows machine `C:\Users\user`).
> See `README.md` for setup/deploy docs; this file is the working history + open items.

## 1. Status (current)

- **Scanner app is DEPLOYED and signing in.** Live at `https://xana-asset-lookup.vercel.app`
  (Vercel, Hobby plan, automatic HTTPS). The Entra redirect URI was added and the
  user confirmed sign-in works.
- **The temporary `Barcode` column was REMOVED from the list** (it was only a test
  scaffold). Lookup now matches on **Title / Asset Tag / Serial Number** only.
- **Source is on GitHub:** `https://github.com/Roystone-Were/Asset-Scanner` (private,
  branch `main`). Deploys are currently manual (`npx vercel deploy --prod --yes`
  from `scanner-app/`) — CI auto-deploy is a known open item.
- **Scalability fixed:** the app now queries Graph with server-side `$filter`
  (with the `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` header, since
  list columns are unindexed) and falls back to a **paged** full fetch
  (`@odata.nextLink`-aware, no `$top=999` ceiling). Verified: `$filter` on
  Title/SerialNumber/Asset returns correct results.

## 2. Goal

1. Make the **Xana Asset Inventory** SharePoint list nicer: color-coded Status,
   row highlighting (**DONE**).
2. Staff scan a physical asset barcode → see that asset's metadata on their phone
   (**DONE** — app deployed; **data gap remains**, see §9).
3. Stable, non-interactive automation for the site (**DONE** via cert auth).

## 3. Environment

- Windows machine, PowerShell 7.6.4 (`pwsh`), Python 3.14 (`py`), Node v24.18.1.
- Workspace: `C:\Users\user\Xana-SharePoint`.
- `C:\Users\user\vcsu-monitor` is an UNRELATED device monitor — do not touch.
- Screenshots: `C:\Users\user\OneDrive - Refrontier Group\Pictures\Screenshots`,
  read with `ocr.ps1`.

## 4. Tenant & List

- Tenant **Refrontier Group** → `refrontiergroup.onmicrosoft.com`; admin
  `itadmin@refrontier.group` (Global Admin).
- Site **Xana Tech & Data**: `https://refrontiergroup.sharepoint.com/sites/xanalifeTechData`
  (private group, 7 members).
- List **Xana Asset Inventory** — 36 items. Graph list Id: `7d3b5f47-8199-4cb9-b7c4-361dc70c4622`.
- Visible columns: Asset Tag, Employee Name, Asset Type, Department, Model,
  Serial Number, Status, Location, Region, Condition.
- **Column internal names (verified via Get-PnPField):**
  - "Asset Tag" is NOT a real column — it's the list **Title** rendered as a
    link (`LinkTitle`); the value lives in `Title`. Item 1: `Title = MICL0045`.
  - "Asset Type" → internal name **`Asset`** (column was renamed at some point;
    internal names never change). Values: Laptop, CPU, Monitor, Mouse, Keyboard.
  - Serial Number → `SerialNumber`; Employee Name → `EmployeeName`;
    Location → `Location`; Region → `Region`; Condition → `Condition`.
- Status choices: `In Use, Available, Retired, Left With` (+ Lost in practice).
- Sample row (item 1): MICL0045 = Lenovo L13, serial `PW0MGGLA`,
  Roystone Licha, Lost, Syokimau.

## 5. Entra App Registration ("pnp") — the key infra

- **ClientId:** `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- **Certificate thumbprint:** `B4437765C89E84AE84B813194E6BD0D54EB3F430`
  (self-signed, in CurrentUser\My; `.pfx`/`.cer` live beside the repo scripts and
  are **NOT committed to git** — `.gitignore` excludes them).
- **Permissions (admin-consented):** Graph `Sites.ReadWrite.All`
  (Delegated + Application), `User.Read` (Delegated); SharePoint `AllSites.*`
  (Delegated). The app requests `Sites.Read.All` at runtime.
- **Redirect URIs (Authentication → Platforms → SPA):**
  - `https://xana-asset-lookup.vercel.app` (production — added, works)
  - `http://localhost:8100` (local dev)
- The old client secret is legacy ACS and unusable — ignore.

## 6. What WORKS (confirmed)

- **Silent PnP cert auth** (no browser):
  ```powershell
  Connect-PnPOnline -Url "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData" `
    -ClientId "7caa51af-9f32-42d8-8264-da5b97c2f8eb" `
    -Tenant "refrontiergroup.onmicrosoft.com" `
    -Thumbprint "B4437765C89E84AE84B813194E6BD0D54EB3F430"
  ```
- `Export-AssetLabels.ps1` exports all items → `scanner-app/assets.csv` / `assets.json`
  (includes AssetType + Location; `Get-FieldV` decodes `_x0020_` and falls back
  `Asset Type` → internal `Asset`).
- Scanner app deployed; MSAL sign-in works; live Graph lookup works.
- **Graph `$filter` on list fields requires an index** (verified): returns
  `400 invalidRequest "Field 'X' ... is not indexed"`. The `Prefer:
  HonorNonIndexedQueriesWarningMayFailRandomly` header bypasses it (works for
  Title/SerialNumber/Asset; the app sends it on filter queries). Attempts to
  index via the `vti_IndexableFieldXML` root-folder property bag did NOT take
  effect — do NOT rely on that trick. If the list grows large, index the
  columns in List Settings → Indexed columns.

## 7. Files inventory

- `scanner-app/index.html` — single-file app (MSAL v2 + html5-qrcode vendored in
  `lib/`). Lookup: server-side `$filter` on Title/SerialNumber/AssetTag with
  Prefer header → paged full-fetch fallback → client-side `matchFields()`.
  `fieldV()`/`normKey()` normalize `_x0020_` internal names.
- `Export-AssetLabels.ps1` — cert-auth CSV/JSON export (now with AssetType+Location).
- `Xana-Asset-Format.ps1` — Status column + row formatting.
- `Add-BarcodeColumn.ps1` / `Remove-BarcodeColumn.ps1` — historical (Barcode
  column added then removed; app no longer uses it).
- `generate-cert.ps1` — created the client cert. `ocr.ps1` — Windows OCR helper.
- `labels/` — deprecated QR label generator (backup only).
- `README.md` — current setup/deploy docs. `HANDOFF.md` — this file.

## 8. Deployment

- Vercel project `xana-asset-lookup` (scope `roystoneweres-projects`), linked in
  `scanner-app/.vercel/` (not committed).
- Manual deploy: `cd scanner-app && npx vercel deploy --prod --yes`.
- **Open:** wire GitHub → Vercel auto-deploy (Project Settings → Git).
- Local dev: `py -m http.server 8100 --directory scanner-app`; for local
  sign-in temporarily set `redirectUri` to `http://localhost:8100` in
  `index.html` (restore before deploying).

## 9. OPEN ITEMS (ranked)

1. **Asset data gap (the real blocker for staff).** Only item 1 has a tag value
   (`Title = MICL0045`). The other 35 assets have no barcode/tag in the list, so
   scanning their vendor barcodes returns "not found". Fix is data-entry: capture
   each device's barcode and store it in Title (or add a dedicated Asset Tag
   column). A bulk-update script (like `Export-AssetLabels.ps1` but with a fill-in
   round trip) is the suggested approach.
2. **Duplicate serials:** `9CP541RLNV` on items 17 & 21; `9CP536240Y` on 16 & 24.
   Since lookup matches serials, duplicates can resolve to the wrong device.
3. **Data hygiene:** "Procuement" typo (item 34), trailing spaces in Employee/Model
   values, empty Serial on items 14/33/37/38.
4. **CI auto-deploy** from GitHub (see §8).
5. Done since last update: Region + Condition rows, scanned-history (24h TTL
   chips), site-id caching, smart input (uppercase + vendor-prefix stripping),
   `Last Verified` writeback (every scan stamps the asset row - audit log),
   PWA install (manifest + service worker + icons), CI auto-deploy from GitHub
   (rootDirectory=scanner-app). Remaining nice-to-haves: Export button,
   register-on-scan flow (the real fix for the 35 missing tags), fuzzy
   "did you mean" matching + unit tests.

## 10. Notes / gotchas

- Re-export after list changes: `pwsh -NoProfile -File Export-AssetLabels.ps1`.
- Cert files + `.vercel/` + `.env.local` are gitignored; keep secrets out of git.
- The app reads live from Graph — `assets.json/csv` are snapshots for labels only.
- git identity (repo-local): `Roystone-Were <patorankingquavo100@gmail.com>`.
