# Xana Asset System

One unified system — **Scan** on the floor + **Dashboard** for execs — live from the **Xana Asset Inventory** SharePoint list.

- **Live app (unified):** `https://<your-project>.vercel.app` → `/` landing, `/scan` scanner, `/dashboard` dashboard
  - Legacy: `https://xana-asset-lookup.vercel.app` (scanner) and `https://asset-scanner-iota.vercel.app` (dashboard) — now combined
- **Source of truth:** Supabase Postgres (project `irqrnyixizzorvfmtvag`, eu-west-1). The SharePoint Online list `Xana Asset Inventory` on `https://refrontiergroup.sharepoint.com/sites/xanalifeTechData` is a **read-only mirror**, kept in sync by the `api/sharepoint-sync.js` worker.
- **Auth:** Supabase email OTP / password — invite-only (admin-managed in `/admin`), with roles `super_admin` · `admin` · `scanner` · `asset_viewer` · `dashboard_viewer`. RLS enforces roles server-side; UI gates are cosmetic.

## What's in this repo

| Path | Purpose |
|---|---|
| `/` (landing) | `index.html` — chooser: Scanner vs Dashboard. `vercel.json` routes `/scan` → `scanner-app/` and `/dashboard` + `/api/*` → `summary/` as one Vercel project. |
| `scanner-app/` | The scanner web app (single-file `index.html` + vendored `lib/`). MSAL sign-in, camera + USB-scanner input, Graph lookup, walk mode, offline cache/queue, item history. `scanner-app/.vercelignore` keeps data snapshots and tests out of the public deployment. |
| `summary/` | Exec dashboard (`index.html` + `app.js` + `api/summary.js` serverless). KPIs, depreciation, health, register with CSV export. Shares Entra auth with scanner. |
| `Export-AssetLabels.ps1` | Silent cert-auth export of the list → `scanner-app/assets.csv` / `assets.json`. |
| `Xana-Asset-Format.ps1` | Applies Status-column color + row formatting to the list. |
| `Add-BarcodeColumn.ps1` / `Remove-BarcodeColumn.ps1` | DEPRECATED (Aug 2026): the `Barcode` column was removed — the barcode on an asset label encodes the tag or serial, so tag/serial matching covers scans. Scripts kept for history. |
| `Add-LastVerifiedColumn.ps1` | Adds the `Last Verified` date column the app writes on every scan. |
| `Add-LastVerifiedByColumn.ps1` | Adds the `Last Verified By` text column the app writes with the signed-in user on every scan (accountability for the health report + history view). |
| `Health-Check.ps1` + `.github/workflows/data-health.yml` | Monthly data-health report (duplicate serials, missing tags/serials, unverified 90+ days) filed as a GitHub issue; unverified assets listed in a table. Optional SMTP email via `Send-HealthEmail.ps1`. |
| `Export-AssetsJson.ps1` | Cert-auth export → `scanner-app/test/fixtures/assets.json` for the golden test suite (commit after bulk list changes). |
| `Index-LookupFields.ps1` | Indexes the lookup columns (`SerialNumber`, `Title`); `-Verify` mode just reports state. |
| `generate-cert.ps1` | Created the self-signed client certificate used for PowerShell automation. |
| `ocr.ps1` | Windows OCR helper for reading screenshots. |
| `labels/` | Deprecated QR label generator (backup only — staff scan existing vendor barcodes, not QRs). |
| `HANDOFF.md` | Full context/history — read it before modifying the tenant-side setup. |

## How the lookup works

The app matches the scanned/typed value (case-insensitive) against these
columns only — a client-side match over the live Supabase register, which is
also cached locally for offline lookups:

- **Title** — this is the "Asset Tag" column you see in the list UI (SharePoint
  renders Title as a link column; internal name `LinkTitle`, value in `Title`)
- **Serial Number** (`SerialNumber`)

The barcode printed on an asset label is not a separate column: it *encodes*
the tag (e.g. a vendor label reading "METROCARE … — MICL0045" scans, gets
cleaned to `MICL0045`, and matches Title) or the serial. A scan that matches
nothing simply isn't in the inventory — the miss screen offers adding the
device as a new asset.

Deliberately **not** matched: the `Asset` column (internal name of **Asset Type** —
Laptop/CPU/Monitor…), so typing "Laptop" can't match every laptop.

Every successful scan also writes a timestamp to **Last Verified** and the
signed-in user to **Last Verified By**, and the result card lets staff change
**Status / Location** inline — routine scans become an automatic inventory
audit. The card's **🕘 History** expander shows SharePoint's version history
(who changed what, when; verification scans collapse to one line).

The app keeps working offline: the last successful fetch is cached locally,
scans match the cache when Graph is unreachable, and any writes made offline
(verify stamps, edits, new assets) queue up and sync automatically
when the connection returns.

The **👥 People** view is the offboarding tool: search an employee, see every
asset assigned to them, and mark a leaver's devices returned in one tap
(Status → Available, Employee cleared).

When a scan misses because the device isn't in the list at all, the miss
screen offers **🆕 Device not in the list — add it**: a minimal form (tag,
serial, model, type, status, location) that creates the item on the spot —
or queues it for sync if offline. Bulk additions are still easiest directly
in SharePoint; the form is for the field.

The camera offers **torch and zoom** controls while scanning — shown only
when the device supports them, so the view stays clean. Interface motion
(card entrances, screen switches, the add-asset bottom sheet, toast
notifications) is plain CSS/Web Animations — no animation library, no build
step, and it all switches off automatically for users who prefer reduced
motion.

**Walk mode** (🚶 button) is built for inventory walks: continuous scanning
with hit/miss counters, instant flash + beep + vibrate feedback, and no taps
between scans. USB barcode scanners (keyboard/"wedge" mode) are detected
anywhere in the app — scan into a laptop and the lookup fires by itself.

On desktop (≥768px) the layout widens, the result card shows its fields in
two columns, and keyboard shortcuts apply: **W** toggles walk mode, **/**
focuses the input, **Esc** exits walk mode. Mobile is unchanged.

Field-name lookups tolerate internal-name quirks: "Asset Type" may come back from
Graph as `AssetType` or `Asset_x0020_Type`; `fieldV()` normalizes `_xNNNN_` hex
escapes and case before comparing. (The renamed column here lives at internal name
`Asset`.)

## Entra app registration (`pnp`) — sync worker only

The browser apps no longer talk to Microsoft. The Entra app is used solely by
`api/sharepoint-sync.js` (client-credentials flow) and the PowerShell
automation scripts:

- **Client ID:** `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- **Tenant:** `refrontiergroup.onmicrosoft.com`
- **Graph application permission:** `Sites.ReadWrite.All` (admin-consented)

All interactive sign-in runs through Supabase Auth (`/login`); staff accounts
are created by an admin via `/admin` (email invite or manual password).

`Health-Check.ps1` (run monthly by `.github/workflows/data-health.yml`) checks the
list for duplicate serial numbers, missing tags/serials,
missing/renamed columns, and assets not verified in 90 days — unverified assets
appear in a Markdown table. The report leads with a **health score** (share of
assets fully clean) and, from the second month on, **month-over-month deltas**
(the workflow commits an aggregate `health-history.json` after each run).
It also warns when the automation client certificate has less than 90 days
left. When issues are found the workflow files a GitHub issue (@mentioning
the owner) and can email the report via SMTP (`Send-HealthEmail.ps1`, off by
default — needs the `SMTP_*` secrets).

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
# Serve unified app (landing + scan + dashboard)
py -m http.server 8100
# Open http://localhost:8100/          (landing)
#      http://localhost:8100/scan      (scanner)
#      http://localhost:8100/dashboard (dashboard - needs vercel dev for /api)

# Dashboard API locally needs Vercel dev (for /api/summary):
# vercel dev  (from repo root, needs SUMMARY_* + CLIENT_SECRET env)
```



Unified project: root `vercel.json` routes `/scan` → `scanner-app/`, `/dashboard` + `/api` → `summary/`. Deploy from repo root:

```bash
npx vercel deploy --prod --yes
# or: npx vercel --prod  (first time, set project root to repo root)
```

For CI auto-deploys, connect the GitHub repo in the Vercel dashboard (Project → Settings → Git, root directory = `/`). Legacy projects (`xana-asset-lookup` and `asset-scanner-iota`) can be archived after the unified URL is verified.

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
  web app always reads live from Graph. They contain employee names and serials,
  so they must never deploy publicly — `scanner-app/.vercelignore` enforces that
  (old Vercel deployments from before Aug 2026 should be deleted from the
  dashboard).
