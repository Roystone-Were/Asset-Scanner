# Xana Asset System — Handoff Notes

> Purpose: orient another AI agent (or engineer) picking this up, and give the
> tenant-side (Entra/SharePoint) context needed before touching that half of
> the system. For day-to-day operation, read `docs/IT_Manager_Handoff_2026-08-26.md`
> first — it's the current, detailed runbook. This file is the narrative:
> how we got here, and what's still open.
>
> Last reconciled: 2026-08-27. Previous version of this file described the
> pre-migration (SharePoint + MSAL, browser talks to Graph directly)
> architecture as current — it wasn't anymore; see §1.

## 0. Where to look for what

| Question | Read |
|---|---|
| How do I deploy / set up locally? | `README.md` |
| What's the current live state (counts, env vars, runbooks)? | `docs/IT_Manager_Handoff_2026-08-26.md` |
| What does the app do, for a non-technical reader? | `docs/APP_WHAT_IT_DOES.md`, `docs/CEO_Executive_Briefing_2026-08-26.md` |
| Why is it built this way? | `docs/decisions/ADR-001..003` |
| What happened, in order, during the migration? | `PROGRESS.md` |
| Tenant/Entra/SharePoint specifics, history, this session's narrative | This file |
| What should be built next (feature roadmap, not infra)? | `asset-management-how-we-achieve-this.md` |

## 1. Architecture — what changed since this file was last accurate

The system was rebuilt in August 2026. **Supabase Postgres is now the source
of truth; SharePoint is a read-only mirror.** This file previously described
the *pre-migration* setup (browser MSAL → Graph direct) as current — that
architecture is retired. See `docs/decisions/ADR-001-supabase-source-of-truth.md`
for the full rationale; short version:

```
Apps (/assets /dashboard /admin /login) ──supabase-js──▶ Supabase Postgres
                                              │ trigger → sharepoint_sync outbox
                                              │ pg_net instant + pg_cron 5-min retry
                                              ▼
                         Vercel fn api/sharepoint-sync.js ──Graph API──▶ SharePoint list (mirror)
```

- Auth is Supabase email OTP/password (invite-only via `/admin`), roles
  `super_admin · admin · scanner · asset_viewer · dashboard_viewer`, RLS
  server-side. MSAL / browser Graph sign-in is **gone** — `api/summary.js`
  (the old MSAL-backed dashboard API) has been deleted from `api/`.
- The repo root is now `Asset-Scanner`, deployed as **one** Vercel project
  (`xana-assets.vercel.app`) serving `/assets`, `/dashboard`, `/admin`,
  `/login`. The old two-project split (`xana-asset-lookup` scanner +
  `asset-scanner-iota` dashboard) is legacy — see README's note to archive
  those once the unified URL is confirmed.
- Live counts as of 2026-08-26 (see `docs/IT_Manager_Handoff_2026-08-26.md` §3):
  **144 assets** in Supabase (not the 36-item SharePoint list this file used
  to cite), 781 sync rows `done`, 0 pending/failed.

**What SharePoint/Entra is still for:** the sync worker's write path
(`api/sharepoint-sync.js`), the monthly `Health-Check.ps1` report, and the
label/backfill PowerShell scripts. All of those still authenticate the same
way described in §5 below — that part of the tenant setup **is** still
accurate and worth reading before changing it.

## 2. Goal (updated)

1. ~~Make the SharePoint list nicer~~ — superseded; SharePoint is now a
   generated mirror, not hand-maintained.
2. Staff scan a physical asset barcode → see/edit that asset on their phone —
   **DONE**, now against Supabase (offline-first, walk mode, USB wedge
   scanners, People/offboarding view — all live).
3. Stable, non-interactive automation for the SharePoint side — **DONE**,
   unchanged: cert auth (§5/§6 below) still runs the sync worker and
   PowerShell scripts.
4. *(new)* Supabase as system of record, one-way mirror to SharePoint for
   exec/Power-Apps compatibility — **DONE**, live since 2026-08-22
   (`docs/decisions/ADR-001...md`).

## 3. Environment

- Windows machine, PowerShell 7.6.4 (`pwsh`), Python 3.14 (`py`), Node v24.18.1.
- **Workspace: `C:\Users\user\Asset-Scanner`** (this file used to say
  `C:\Users\user\Xana-SharePoint` — that path is stale/retired).
- `C:\Users\user\vcsu-monitor` is an UNRELATED device monitor — do not touch.
- Screenshots: `C:\Users\user\OneDrive - Refrontier Group\Pictures\Screenshots`,
  read with `ocr.ps1`.
- `gh` CLI is still **not installed** here — branch-protection and other
  GitHub-UI-only steps (§9) can't be verified or set from the repo; do them
  in the browser or via REST + a PAT.

## 4. Tenant & List (SharePoint side — mirror only now)

- Tenant **Refrontier Group** → `refrontiergroup.onmicrosoft.com`; admin
  `itadmin@refrontier.group` (Global Admin).
- Site **Xana Tech & Data**: `https://refrontiergroup.sharepoint.com/sites/xanalifeTechData`
  (private group, 7 members).
- List **Xana Asset Inventory**, Graph list Id `7d3b5f47-8199-4cb9-b7c4-361dc70c4622`.
  Row count now tracks Supabase via the sync worker (144 assets as of
  2026-08-26) — the "36 items" and "61 items" figures previously in this file
  were snapshots from before the Supabase migration and bulk imports; don't
  treat either as current. Check live counts via `docs/IT_Manager_Handoff...md`
  §3 or a fresh `Health-Check.ps1` run.
- Idempotency: a `SupabaseId` text column (added manually — the sync app
  lacks schema rights) fingerprints every mirrored row with `assets.item_id`.
- Column internal names (verified via `Get-PnPField`, still accurate):
  - "Asset Tag" is NOT a real column — it's the list **Title** rendered as a
    link (`LinkTitle`); the value lives in `Title`.
  - "Asset Type" → internal name **`Asset`** (renamed at some point; internal
    names never change).
  - Serial Number → `SerialNumber`; Employee Name → `EmployeeName`;
    Location → `Location`; Region → `Region`; Condition → `Condition`;
    Last Verified → `LastVerified`; Last Verified By → `LastVerifiedBy`.
  - `Barcode` column: **removed** (Aug 2026) — the printed barcode encodes the
    tag/serial, so a separate column was redundant.
  - Status/Location columns were converted from Choice to plain text (done in
    the SharePoint UI) so new `app_choices` values mirror freely without a
    schema edit on the SharePoint side.

## 5. Entra App Registration ("pnp") — sync worker + automation only

Still the correct, current setup — nothing here changed with the migration,
it's just no longer used by any browser code (see §1):

- **ClientId:** `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- **Certificate thumbprint:** `B4437765C89E84AE84B813194E6BD0D54EB3F430`
  (self-signed, in CurrentUser\My; `.pfx`/`.cer` live beside the repo scripts,
  **not committed** — gitignored).
  **Rotating:** run `generate-cert.ps1` — it creates a new cert with a
  **random pfx password** (saved locally to `pnp-cert-pass.txt`, gitignored;
  there is no default password since the 2026-09 rotation), prints the
  thumbprint, and lists the follow-ups: upload the `.cer` to the Entra app
  registration, update GitHub secrets `SP_CERT_B64` / `SP_CERT_PASS` /
  `SP_THUMBPRINT`, run the data-health workflow manually to verify, then
  delete the old cert from Entra. Update the thumbprint default in the PS
  scripts and the references in this file + `README.md`.
- **Graph application permission:** `Sites.ReadWrite.All` (admin-consented) —
  used by `api/sharepoint-sync.js` (client-credentials flow) and by the
  PowerShell automation scripts.
- Redirect URIs under Authentication → Platforms → SPA are vestigial now
  (no browser code does interactive Entra sign-in any more) — safe to leave,
  not worth cleaning up.
- The old client secret (legacy ACS) is unusable — ignore it, or revoke it
  as cleanup (§9).

## 6. What WORKS (confirmed, tenant/automation side)

- **Silent PnP cert auth** (no browser) — used by `Health-Check.ps1`,
  `Export-AssetLabels.ps1`, `Export-AssetsJson.ps1`, `Index-LookupFields.ps1`,
  and the newer `Add-MonitorRows.ps1` / `Add-ScannerAccessList.ps1` /
  `Import-ResultsToSharePoint.ps1` / `backfill/*.ps1`:
  ```powershell
  Connect-PnPOnline -Url "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData" `
    -ClientId "7caa51af-9f32-42d8-8264-da5b97c2f8eb" `
    -Tenant "refrontiergroup.onmicrosoft.com" `
    -Thumbprint "B4437765C89E84AE84B813194E6BD0D54EB3F430"
  ```
- **Graph `$filter` on list fields requires an index** (verified):
  `SerialNumber` and `Title` are indexed via `Index-LookupFields.ps1`
  (`Set-PnPField -Values @{ Indexed = $true }` — the old
  `vti_IndexableFieldXML` property-bag trick does **not** work). Run with
  `-Verify` to check state without changing anything.
- The Supabase→SharePoint sync worker uses the same cert-free
  client-credentials Graph token internally (`api/sharepoint-sync.js`), plus
  `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` when it queries by
  `SupabaseId` (that column isn't indexed — optional perf win, still open,
  see §9).

## 7. Files inventory (current, root of `Asset-Scanner`)

| Path | Purpose |
|---|---|
| `index.html` | Landing chooser (Assets / Dashboard / Admin). |
| `assets/index.html` | The register: scan, edit, people/offboarding — this replaced the old standalone `scanner-app` page. |
| `summary/` | Exec dashboard (`index.html` + `app.js`), now reading Supabase client-side. `summary/README.md` still describes the **old** MSAL-backed `api/summary.js` design — that file no longer exists in `api/`; treat `summary/README.md` as stale too, not just this file. |
| `admin/index.html` | Users, `app_choices` lists, sync-health tab. |
| `login/index.html` | Single sign-in for all apps. |
| `js/supabase-client.js` | Shared `XanaSupabase` adapter (list/enrich/computeSummary/insert/update/delete/images/events/roles) used across `/assets`, `/dashboard`, `/admin`. |
| `scanner-app/` | No longer a page — vendored libs (`lib/supabase.min.js`, `lib/html5-qrcode.min.js`), pure logic (`logic.js`) + its test suite, icons/logo. |
| `api/sharepoint-sync.js` | Outbox drain worker: claim-based concurrency, 429/5xx backoff, Graph create/patch/delete. |
| `api/admin-users.js` | Invite / set_roles / set_active / delete_user — verifies caller JWT + admin server-side. |
| `supabase/migrations/0001..0022` | Schema, outbox, RBAC, `asset_history`, `asset_events`, `recycle_bin`, image storage, unique tag index. |
| `scripts/` | `backfill.mjs`, `apply-migration.mjs`, `health-check-db.mjs`, several `e2e-*.mjs` and `debug-*.mjs` harnesses. |
| `backfill/Backfill-PurchaseData.ps1`, `backfill/Export-MissingPurchase.ps1` | CSV-driven Purchase Date/Price backfill pass (export blanks → fill → re-import). |
| `Add-MonitorRows.ps1` | One-off: splits monitor rows out of CPU host "Results" CSVs into separate assets. |
| `Add-ScannerAccessList.ps1` | Creates the `Scanner Access` SharePoint allowlist (now mirrored by `allowed_scanners` in Supabase; admin-managed via `/admin`). |
| `Import-ResultsToSharePoint.ps1` | One-off bulk import of desktops/POS from OneDrive `Results` CSVs. |
| `Export-AssetLabels.ps1` / `Export-AssetsJson.ps1` | Cert-auth exports (labels CSV/JSON; golden-test fixture). |
| `Xana-Asset-Format.ps1` | Status-column color + row formatting on the SharePoint mirror. |
| `Index-LookupFields.ps1` | Indexes `SerialNumber`/`Title` for `$filter`. |
| `Health-Check.ps1` + `.github/workflows/data-health.yml` | Monthly data-health report (cert auth) → GitHub issue, optional SMTP email. |
| `Add-LastVerifiedColumn.ps1` / `Add-LastVerifiedByColumn.ps1` | Idempotent column-add scripts, already applied to the live list. |
| `Add-BarcodeColumn.ps1` / `Remove-BarcodeColumn.ps1` | DEPRECATED — `Barcode` column removed Aug 2026; kept for history. |
| `generate-cert.ps1` | Created the client cert. `ocr.ps1` — Windows OCR helper for screenshots. |
| `labels/` | Deprecated QR label generator (backup only). |
| `docs/` | `APP_WHAT_IT_DOES.md`, `CEO_Executive_Briefing_2026-08-26.md`, `IT_Manager_Handoff_2026-08-26.md`, `decisions/ADR-001..003`. |
| `references/session-aug25-2026-session2.md` | Prior session notes. |
| `README.md` | Setup/deploy docs. `PROGRESS.md` | Migration log. `HANDOFF.md` | This file. |

## 8. Deployment

- One Vercel project, root of repo, domain `xana-assets.vercel.app`
  (see `docs/IT_Manager_Handoff_2026-08-26.md` §7 for the routing table and
  local-dev harness). No build step — static + `api/*.js` serverless
  functions.
- GitHub → Vercel auto-deploy: every push to `main` on
  `github.com/Roystone-Were/Asset-Scanner` deploys. `test` workflow
  (`.github/workflows/test.yml`) runs scanner unit tests + syntax-checks the
  two `api/*.js` functions on every push/PR.
- The **legacy two-project split** (`xana-asset-lookup.vercel.app` scanner,
  `asset-scanner-iota.vercel.app` dashboard) predates the unified app —
  archive both in the Vercel dashboard once nobody's bookmarked them, and
  delete any old immutable deployments that still serve `assets.csv`/`.json`
  publicly (privacy fix, see git history — `.vercelignore` now prevents new
  ones but old deployment URLs are immutable).

## 9. OPEN ITEMS (ranked, reconciled against `docs/IT_Manager_Handoff_2026-08-26.md` §12 and `PROGRESS.md`)

1. **Delete old Vercel deployments** that still serve `assets.csv`/`assets.json`
   publicly at their immutable URLs (Deployments → … → Delete, or `npx vercel rm`).
2. **Finance: clear the 100 `estimate_pending` assets** by 30 Sept 2026 —
   biggest remaining data-quality gap; makes book-value totals trustworthy
   (echoes §10 of `asset-management-how-we-achieve-this.md`).
3. **Sweep the 19 assets unverified >90 days** — one Walk-mode pass covers it.
4. **Index `SupabaseId` in SharePoint** (List settings → Columns → Indexed) —
   pure perf win for the sync worker's duplicate-check query; not urgent
   (worker already works around it with the `Prefer` header).
5. **CI branch-protection gate** — status unverified this session (`gh` CLI
   not installed, didn't check GitHub UI). Settings → Branches → require the
   `test` check on `main`. Do before treating a green push as a deploy
   guarantee.
6. **Monthly data-health workflow secrets** (`SP_TENANT`, `SP_CLIENT_ID`,
   `SP_CERT_B64`, `SP_THUMBPRINT`, optional `SP_CERT_PASS`) — status
   unverified; confirm they're set in GitHub → Settings → Secrets and
   variables → Actions, or the monthly cron silently has nothing to auth with.
7. **Revoke the orphan legacy client secret** in the Entra app registration —
   still just a dangling unused credential; low urgency, do during a tenant
   cleanup pass.
8. **Retire `api/summary.js` references** — the file itself is already gone
   from `api/`, but `summary/README.md` and root `package.json`
   (`@azure/msal-node` dependency) still describe/depend on the retired
   MSAL-backed design. Worth a small doc/dependency cleanup pass so a future
   reader doesn't chase a dead file.
9. Longer-term roadmap (features, not infra): see
   `asset-management-how-we-achieve-this.md` — §10 data quality and §1
   lifecycle (`asset_events`) are the recommended next build targets.

## 10. Notes / gotchas

- Re-export after list changes: `pwsh -NoProfile -File Export-AssetLabels.ps1`
  (labels) and `pwsh -NoProfile -File Export-AssetsJson.ps1` (golden-test
  fixture — commit the new `assets.json`).
- `health-report.md` is gitignored — regenerated by `Health-Check.ps1`; the
  monthly report lives in a GitHub issue + optional email, never in git.
- Cert files, `.vercel/`, and `.env.local` are gitignored — keep secrets out
  of git. `.env.local` now holds Supabase keys too (see
  `docs/IT_Manager_Handoff_2026-08-26.md` §4) — treat it as more sensitive
  than it was pre-migration.
- `SUPABASE_DB_URL`'s password contains `#` — always percent-encode
  (`%23`) when using it outside `apply-migration.mjs` (which already does
  `encodeURIComponent`).
- git identity (repo-local): `Roystone-Were <patorankingquavo100@gmail.com>`.
- The app now reads live from Supabase, not Graph — `assets.json`/`assets.csv`
  are still just label-generator snapshots, same as before.
