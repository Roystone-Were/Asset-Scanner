# Xana Asset Lookup

Staff scan a physical asset barcode (or type a tag/serial) and instantly see that
asset's metadata — pulled live from the **Xana Asset Inventory** SharePoint list.

- **Live app:** https://xana-asset-lookup.vercel.app
- **Data source:** SharePoint Online list `Xana Asset Inventory` (36 items) on
  `https://refrontiergroup.sharepoint.com/sites/xanalifeTechData`
- **Auth:** Microsoft Entra (MSAL.js v2) — staff sign in with their own work
  account; the app reads the list as the signed-in user via Microsoft Graph.

## What's in this repo

| Path | Purpose |
|---|---|
| `scanner-app/` | The web app (single-file `index.html` + vendored `lib/` + exported data). MSAL sign-in, camera barcode scanning (html5-qrcode), Graph lookup. |
| `Export-AssetLabels.ps1` | Silent cert-auth export of the list → `scanner-app/assets.csv` / `assets.json`. |
| `Xana-Asset-Format.ps1` | Applies Status-column color + row formatting to the list. |
| `Add-BarcodeColumn.ps1` / `Remove-BarcodeColumn.ps1` | Add/remove the `Barcode` column — currently present, as the register-on-scan target. |
| `Add-LastVerifiedColumn.ps1` | Adds the `Last Verified` date column the app writes on every scan. |
| `Health-Check.ps1` + `.github/workflows/data-health.yml` | Monthly data-health report (duplicate serials, missing tags/serials, unverified 90+ days) filed as a GitHub issue; unverified assets listed in a table. Optional SMTP email via `Send-HealthEmail.ps1`. |
| `Export-AssetsJson.ps1` | Cert-auth export → `scanner-app/test/fixtures/assets.json` for the golden test suite (commit after bulk list changes). |
| `Index-LookupFields.ps1` | Indexes the lookup columns (`SerialNumber`, `Barcode`, `Title`); `-Verify` mode just reports state. |
| `generate-cert.ps1` | Created the self-signed client certificate used for PowerShell automation. |
| `ocr.ps1` | Windows OCR helper for reading screenshots. |
| `labels/` | Deprecated QR label generator (backup only — staff scan existing vendor barcodes, not QRs). |
| `HANDOFF.md` | Full context/history — read it before modifying the tenant-side setup. |

## How the lookup works

The app matches the scanned/typed value (case-insensitive) against these columns
only — server-side Graph `$filter` on indexed columns, with a paged full-fetch
fallback:

- **Title** — this is the "Asset Tag" column you see in the list UI (SharePoint
  renders Title as a link column; internal name `LinkTitle`, value in `Title`)
- **Serial Number** (`SerialNumber`)
- **Barcode** — the register-on-scan target: when a scan misses, staff tap
  "Register this barcode", pick the device, and the app writes the scanned value
  into this column.

Deliberately **not** matched: the `Asset` column (internal name of **Asset Type** —
Laptop/CPU/Monitor…), so typing "Laptop" can't match every laptop.

Every successful scan also writes a timestamp to **Last Verified**, and the result
card lets staff change **Status / Location** inline — routine scans become an
automatic inventory audit.

Field-name lookups tolerate internal-name quirks: "Asset Type" may come back from
Graph as `AssetType` or `Asset_x0020_Type`; `fieldV()` normalizes `_xNNNN_` hex
escapes and case before comparing. (The renamed column here lives at internal name
`Asset`.)

## Entra app registration (`pnp`)

- **Client ID:** `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- **Tenant:** `refrontiergroup.onmicrosoft.com`
- **SPA redirect URIs (Authentication → Platforms):**
  - `https://xana-asset-lookup.vercel.app` (production)
  - `http://localhost:8100` (local dev)
- **Graph delegated permissions (admin-consented):** `Sites.ReadWrite.All`,
  `User.Read`; the app requests `Sites.Read.All` at runtime.
- Staff only need **read access to the site** (members of the private group) to use
  the app — no admin rights.

## Data health

`Health-Check.ps1` (run monthly by `.github/workflows/data-health.yml`) checks the
list for duplicate serial numbers, duplicate barcodes, missing tags/serials,
missing/renamed columns, and assets not verified in 90 days — unverified assets
appear in a Markdown table. It also warns when the automation client certificate
has less than 90 days left. When issues are found the workflow files a GitHub
issue (@mentioning the owner) and can email the report via SMTP
(`Send-HealthEmail.ps1`, off by default — needs the `SMTP_*` secrets).

## Hardening checklist (manual, one-time)

- **CI deploy gate:** GitHub → Settings → Branches → require the `test` status
  check on `main` so failing tests can't reach production.
- **Secrets for the data-health workflow:** `SP_TENANT`, `SP_CLIENT_ID`,
  `SP_CERT_B64` (base64 of `pnp-cert.pfx`), `SP_THUMBPRINT`, and optionally
  `SP_CERT_PASS` (the pfx password — unset falls back to the original).
- **Site sharing:** give scanning staff **Contribute** on the list so
  register-on-scan and Status/Location edits work (the app requests
  `Sites.ReadWrite.All` delegated, but that can't exceed each user's own
  permission).
- **Revoke the orphan client secret** (legacy ACS, unused) in the Entra app
  registration.
- **Monthly cron note:** GitHub disables scheduled workflows after 60 days of
  repo inactivity — re-enable via Actions → `data-health` → Enable, or run it
  manually with **Run workflow**.

## Local development

```bash
# Serve the app
py -m http.server 8100 --directory scanner-app
```

Open `http://localhost:8100`. For local sign-in, temporarily set `redirectUri` in
`scanner-app/index.html` to `http://localhost:8100`, then restore it before
deploying (the hosted value is `https://xana-asset-lookup.vercel.app`).

## Deploying to Vercel

The project is linked to Vercel (see `.vercel/`, not committed). From `scanner-app/`:

```bash
npx vercel deploy --prod --yes
```

For CI auto-deploys, connect the GitHub repo in the Vercel dashboard
(Project → Settings → Git).

## Re-exporting the asset data

```powershell
pwsh -NoProfile -File Export-AssetLabels.ps1
```

Requires the PnP module and the client certificate (thumbprint
`B4437765C89E84AE84B813194E6BD0D54EB3F430` — `.pfx`/`.cer` live next to this file
**and are intentionally NOT committed**; keep them out of git).

## Notes / gotchas

- Camera scanning needs HTTPS (secure context) — satisfied by the Vercel URL;
  `localhost` also works for desktop testing.
- The list previously had duplicate serial numbers (e.g. `9CP541RLNV` on two
  rows); the latest health-check run found none — the monthly report will catch
  any that reappear.
- `assets.json`/`assets.csv` are exported snapshots (for the label generator); the
  web app always reads live from Graph.
