# Xana Asset Lookup & SharePoint List Modernization — Handoff Notes

> Purpose: give another AI agent (or engineer) full context to continue this work.
> Last updated: session on the user's Windows machine (`C:\Users\user`).

## 1. Goal
1. Make the **Xana Asset Inventory** SharePoint list nicer: color-coded Status, row highlighting (**DONE**).
2. Implement: **staff scan a physical asset barcode → see that asset's metadata** (employee, type, model, serial, status) on their phone. This is the **open / in-progress** item.
3. Stable, non-interactive automation for the site (**mostly DONE** via certificate auth).

## 2. Environment
- Windows machine, PowerShell 7.6.4 at `C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe`; Windows PowerShell 5.1 also present.
- Python 3.14 (launcher `py`), Node v24.18.1 — both available.
- Main workspace: **`C:\Users\user\Xana-SharePoint`** (dedicated to this project).
- Screenshots live in `C:\Users\user\OneDrive - Refrontier Group\Pictures\Screenshots` — read them with `ocr.ps1` (Windows built-in OCR, no installs).
- `C:\Users\user\vcsu-monitor` is an UNRELATED device-uptime monitor — do not touch (was briefly used as scratch, now clean).

## 3. Tenant & List
- Tenant: **Refrontier Group** → `refrontiergroup.onmicrosoft.com`; admin account `itadmin@refrontier.group` (Global Admin).
- Site: **Xana Tech & Data** → `https://refrontiergroup.sharepoint.com/sites/xanalifeTechData` (Private group, 7 members).
- List: **Xana Asset Inventory** → `/Lists/Xana%20Asset%20Inventory/AllItems.aspx` — **36 items**.
- Columns: `Asset Tag, Asset Type, Department, Model, Status, Employee Name, Serial Number` + **`Barcode`** (added for scanning; test value `MICL0045` on item Id 1).
- Status choices: **`In Use, Available, Retired, Left With`**.
- Sample row: Xana001 = Lenovo L13, serial `PW0MGGLA`, employee Roystone Licha, Status Lost.
- Serials are HP/Dell-style (e.g. `4CE543BWTT`, `CN-09094X`, `CZC2...`, `9CP...`).
- The vendor barcode sample user provided: **`METROCARE IMAGING CENTER LIMITED — MICL0045`** (linear barcode). Design: barcode value = asset tag number, matched in the list.

## 4. Entra App Registration ("pnp") — THE key infra
- **ClientId:** `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- **Certificate thumbprint:** `B4437765C89E84AE84B813194E6BD0D54EB3F430` (self-signed, in CurrentUser\My; `.pfx`/`.cer` in `Xana-SharePoint`).
- **Permissions (all admin-consented):**
  - Microsoft Graph: `Sites.ReadWrite.All` (Delegated ✅ + Application ✅), `User.Read` (Delegated ✅).
  - SharePoint Online: `AllSites.FullControl`, `AllSites.Read`, `AllSites.Write` (all Delegated ✅).
  - Note: `AllSites.FullControl` is **Delegated**; for app-only (cert) they should be **Application** — however cert auth currently works for CSOM reads/writes, so acceptable.
- **Redirect URIs:**
  - SPA: **`http://localhost:8100`**
  - Mobile/desktop: `https://login.microsoftonline.com/common/oauth2/nativeclient`, `http://localhost`, `http://localhost:8000`
- A **client secret** was created (`MPQ8Q~...`) but is **NOT usable** — PnP's `-ClientSecret` = legacy ACS, not Entra. Ignore it.
- **Important history:** PnP's built-in default app was rejected early ("Please specify a valid client id") — that is because **PnP 3.x requires a custom client id**, NOT necessarily a tenant block.

## 5. What WORKS (confirmed)
- **Silent PnP auth via certificate** — no browser, no prompt. Pattern:
  ```powershell
  Import-Module PnP.PowerShell
  Connect-PnPOnline -Url "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData" -ClientId "7caa51af-9f32-42d8-8264-da5b97c2f8eb" -Tenant "refrontiergroup.onmicrosoft.com" -Thumbprint "B4437765C89E84AE84B813194E6BD0D54EB3F430"
  ```
- `Export-AssetLabels.ps1` exports all 36 items → `scanner-app/assets.csv` / `assets.json`.
- **Color formatting already applied & live** on the Status column (JSON) + row highlighting on "All Items" view.
- Added the `Barcode` column and set `MICL0045` on item 1 (test).
- Generated a printable QR label sheet `labels/asset-labels.html` (**deprecated / backup only** — user wants to scan existing vendor barcodes, not new QRs).

## 6. Files inventory (`C:\Users\user\Xana-SharePoint`)
- `Xana-Asset-Format.ps1` — applies Status column + row formatting (silent cert auth).
- `Add-BarcodeColumn.ps1` — added the Barcode column + test value.
- `Remove-BarcodeColumn.ps1` — cleanup for an earlier temp column.
- `Export-AssetLabels.ps1` — exports list to CSV/JSON.
- `generate-cert.ps1` — created the self-signed cert (thumbprint above).
- `ocr.ps1` — reads a screenshot/png via Windows OCR.
- `scanner-app/` — **the main deliverable**: `index.html` (single-file web app) + `lib/msal-browser.min.js`, `lib/html5-qrcode.min.js` (vendored locally), `assets.csv`, `assets.json`.
- `labels/` — QR label sheet + Node generator (`make-labels.mjs`).

## 7. THE OPEN PROBLEM — web-app auth loop (UNRESOLVED)
The scanner web app `scanner-app/index.html`:
- Uses **MSAL.js v2** (vendored) + Microsoft **Graph** (`Sites.ReadWrite.All`) to look up assets by `Barcode`/`Serial Number`/`Asset Tag`.
- Lookup logic is **complete and validated** (JS syntax OK; server runs on `http://localhost:8100`, HTTP 200).
- **Blocker:** sign-in never completes. Symptoms seen:
  - popup flow → Microsoft "Pick an account" → **"We couldn't sign you in. Please try again."**
  - redirect flow → **infinite redirect loop** between the app and Microsoft.
- **Root cause is UNKNOWN.** We have NOT seen the actual `AADSTSxxxxx` error code.
- Recent hardening added: app now shows the sign-in error text on the page and **caps redirects at 2** so it stops looping and displays the error; a global `window.onerror` surfaces any JS error into the `#authState` div. **So the next step is trivial:** reload `http://localhost:8100`, screenshot the on-page `🚫 Sign-in error: <code>` text, and read the `AADSTS` code.
- Likely candidates (unsorted): (a) a Conditional Access policy blocking the custom app, (b) an app-side MSAL/redirect-URI displacement issue, (c) scope/consent nuance. It is **not confirmed** the tenant blocks custom apps.

## 8. Next steps for the receiving agent
1. **Get the real error:** have user reload `http://localhost:8100` and screenshot the on-page error (`AADSTSxxxxx`). Then decide:
   - If CA block (`AADSTS53003` etc.) → user (Global Admin) creates a Conditional Access exemption for app `7caa51af-...` (or adjust the offending policy).
   - If app-side → fix redirect/scope/config in `index.html`.
2. Choose the delivery path (depends on whether custom-app auth can work):
   - **A. Fix the existing web app** (if error is app-side or CA exempt) → then deploy behind HTTPS for phones (Azure Static Web App or HTTPS host), since the **camera needs a secure context** (localhost is fine for desktop testing; phones need HTTPS).
   - **B. SPFx web part** (the "I build it for you" path): host the scan→lookup inside the SharePoint site, uses the viewer's existing login (no custom auth / no CA fight). Requires SharePoint admin app catalog — user is Global Admin. This is the most robust for a locked tenant; the agent should scaffold + build the `.sppkg`.
   - **C. Power Apps** (first-party, works in locked tenants, but GUI-only — cannot be scripted; user must build in Studio). Recipe included below.

## 9. Power Apps recipe (alternative C), if needed
- Blank canvas app, Phone layout; data source: SharePoint `'Xana Asset Inventory'`.
- `BarcodeScanner1.OnScan`:
  ```powerapps
  Set(varCode, BarcodeScanner1.Value);
  Set(varMatch, LookUp('Xana Asset Inventory', Barcode = BarcodeScanner1.Value));
  Set(varFound, varMatch <> Blank())
  ```
- Look-up button `OnSelect` (manual input `TextInput1`): same but `Barcode = TextInput1.Text`.
- Labels `.Text`: `"Asset: " & varMatch.'Asset Tag'`, `"Type: " & varMatch.'Asset Type'`, `"Model: " & varMatch.Model`, `"Serial: " & varMatch.'Serial Number'`, `"Employee: " & varMatch.'Employee Name'`, `"Department: " & varMatch.Department`, `"Status: " & varMatch.Status`.
- "Not found" label `Visible`: `varCode <> "" && !varFound`.
- Status badge `Fill`: `If(varMatch.Status="Under Repair",Color.Red, varMatch.Status="Lost",Color.DarkRed, varMatch.Status="Available",Color.Orange, varMatch.Status="Retired",Color.Gray, varMatch.Status="Left With",Color.Purple, Color.Green)`.
- Publish + Share to staff (Read on list; Contribute if they update Status).

## 10. Notes / gotchas
- To re-export assets after changes: `pwsh -NoProfile -File C:\Users\user\Xana-SharePoint\Export-AssetLabels.ps1`.
- Regenerate QR labels (backup): in `labels\` run `node make-labels.mjs` (reads `assets.json`).
- Server command: `py -m http.server 8100 --directory C:\Users\user\Xana-SharePoint\scanner-app`.
- The Barcode column test value `MICL0045` is on item 1 so scanning/typing it should produce a match once auth works.
