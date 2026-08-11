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
| `Add-BarcodeColumn.ps1` / `Remove-BarcodeColumn.ps1` | Historical: added/removed a temporary `Barcode` column while proving the scan flow. **The Barcode column is gone** — the app now matches on Title / Asset Tag / Serial Number. |
| `generate-cert.ps1` | Created the self-signed client certificate used for PowerShell automation. |
| `ocr.ps1` | Windows OCR helper for reading screenshots. |
| `labels/` | Deprecated QR label generator (backup only — staff scan existing vendor barcodes, not QRs). |
| `HANDOFF.md` | Full context/history — read it before modifying the tenant-side setup. |

## How the lookup works

The app fetches all list items once per lookup and matches the scanned/typed value
(case-insensitive) against these columns only:

- **Title** — this is the "Asset Tag" column you see in the list UI (SharePoint
  renders Title as a link column; internal name `LinkTitle`, value in `Title`)
- **Asset Tag** (`assettag`) — in case a dedicated column is added later
- **Serial Number** (`SerialNumber`)

Deliberately **not** matched: the `Asset` column (internal name of **Asset Type** —
Laptop/CPU/Monitor…), so typing "Laptop" can't match every laptop.

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
- The list has duplicate serial numbers on a few items (e.g. `9CP541RLNV` on two
  rows) — reconcile them before relying on serial-based matching.
- `assets.json`/`assets.csv` are exported snapshots (for the label generator); the
  web app always reads live from Graph.
