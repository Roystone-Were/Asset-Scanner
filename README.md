# Xana Asset System

The asset register for XanaLife: one web app covering the register, barcode
scanning, offboarding, an exec dashboard and user administration. Supabase
Postgres is the source of truth. The SharePoint list is a read-only mirror
kept in step automatically.

**Live:** https://xana-assets.vercel.app

| Page | What it is | Who gets in |
|---|---|---|
| `/` | Landing and sign-in. Shows only the tiles your roles allow | anyone signed in |
| `/assets` | The register: search, filter, scan, edit, People/offboarding | `asset_viewer`, `scanner`, admins |
| `/dashboard` | Portfolio value, depreciation, warranty and activity KPIs | `dashboard_viewer`, admins |
| `/admin` | Users and roles, dropdown lists, sync health, recycle bin, IT documents | `admin`, `super_admin` |
| `/login` | Magic link or password | anyone |

`/scan` permanently redirects to `/assets`; scanning lives inside the register.

## Architecture

Static HTML pages with no build step, talking straight to Supabase from the
browser through `js/supabase-client.js`. There is no bundler, no framework and
no npm install for the app itself.

```
browser ──> Supabase Postgres (source of truth, RLS enforced)
                 │
                 ├─ assets_to_outbox trigger  ──> sharepoint_sync queue
                 │                                     │
                 │                              api/sharepoint-sync.js
                 │                                     │
                 └─ pg_cron retry sweep (5 min)  ──> SharePoint list (mirror)
```

- **Supabase project** `irqrnyixizzorvfmtvag` (eu-west-1). Every table has RLS;
  the UI gates are convenience, the database is the actual boundary.
- **SharePoint mirror:** `Xana Asset Inventory` on the `xanalifeTechData` site.
  One way only. Nothing written in SharePoint flows back.
- **Auth:** Supabase email magic link or password, invite only. Accounts are
  created by an admin in `/admin`.

## Roles

| Role | Read register | Scan and edit | Delete | Dashboard | Admin |
|---|---|---|---|---|---|
| `asset_viewer` | yes | no | no | no | no |
| `scanner` | yes | yes | no | no | no |
| `dashboard_viewer` | yes | no | no | yes | no |
| `admin` | yes | yes | yes | yes | yes |
| `super_admin` | yes | yes | yes | yes | yes, plus protected accounts |

Roles stack: most staff hold several. Two things worth knowing:

- **Reading anything requires at least one active role** (migration 0029).
  An account with no roles, or one deactivated in `/admin`, reads nothing,
  including through the API. Deactivating someone genuinely cuts them off.
- **`asset_viewer` on its own is view only.** The register renders without
  Scan, Add, inline edit, Verify or Clone, and the database refuses those
  writes regardless. New invites default to this.

## Repo map

| Path | Purpose |
|---|---|
| `index.html` | Landing page and sign-in |
| `assets/` | The register: table, filters, detail card, scanning, People view |
| `summary/` | Exec dashboard (`index.html` + `app.js`), KPIs and CSV exports |
| `admin/` | Admin console: users, lists, sync health, recycle bin, documents |
| `login/` | Sign-in page |
| `js/supabase-client.js` | The one data layer. Field mapping, depreciation, all queries |
| `scanner-app/` | Vendored browser libs, shared pure logic (`logic.js`) and its tests. Not a page any more |
| `css/`, `fonts/` | Shared tokens, page-entry overlay, view transitions, Geist |
| `api/sharepoint-sync.js` | Drains the outbox into SharePoint. Service role, keyed |
| `api/admin-users.js` | Invite, roles, activation, password reset. Verifies the caller is an admin |
| `supabase/migrations/` | Schema and RLS, numbered and applied in order |
| `scripts/` | Migration runner, backfills, e2e and debug tools |
| `backfill/` | Work lists for filling gaps. CSVs stay local, never committed |
| `docs/` | Runbook, what-it-does, exec briefing, ADRs |
| `*.ps1` | PowerShell automation against SharePoint (cert auth) |

## How scanning works

The register matches a scanned or typed code against **asset tag first, then
serial**, case-insensitively, over the register already loaded in the browser.
Tags win because the tag is the label physically on the asset, and some kit
currently carries a placeholder tag in its serial field.

Three ways to scan, all in `/assets`:

- **Scan button:** opens the camera sheet. A hit jumps to that asset's card.
- **Walk mode:** keeps the camera running for stock takes, counting hits and
  misses with flash, beep and vibrate feedback.
- **USB wedge scanner:** works anywhere on the page with no button. Fast
  keystroke bursts ending in Enter are classified as a scan, except while
  typing in a field.

A scan is a verification: it stamps `Last Verified` and the signed in user,
so routine scanning doubles as an inventory audit. A miss offers to add the
device. Read-only roles can do none of this, camera and wedge alike.

## Depreciation

One implementation, `enrichAsset()` in `js/supabase-client.js`. Straight line,
no salvage value, age prorated continuously:

```
annual        = purchase_price / useful_life
accumulated   = min(price, age_in_years x annual)
book value    = max(0, price - accumulated)
status        = "No data" | "In progress" | "Fully depreciated"
```

Useful life resolves in this order:

1. `extra.useful_life` on the individual asset, if set
2. `app_choices.useful_life` for its type, editable in **Admin > Lists**
3. the built-in `USEFUL_LIFE_BY_TYPE` map, as a fallback
4. 3 years

So adding a new asset type and giving it a depreciation life is entirely
self-service. No code change, no deploy.

An asset with no purchase date reads "No data", holds full book value and
never depreciates, so gaps show up rather than quietly distorting the numbers.

## Deploying

**Push to `main`.** Vercel's Git integration builds and promotes automatically.
There is no CLI step; `.vercel/project.json` only records a one time
`vercel link`. Confirm the deploy landed rather than assuming:

```bash
git push
curl -s https://xana-assets.vercel.app/js/supabase-client.js | grep "something only the new build has"
```

## Database migrations

Numbered SQL in `supabase/migrations/`, applied through the Management API:

```bash
node scripts/apply-migration.mjs supabase/migrations/00NN_name.sql
```

The runner prints `HTTP 201` on success. On Windows it may follow that with a
libuv assertion during teardown; the migration has already applied.

## Local development

```bash
py -m http.server 8100      # or any static server from the repo root
# http://localhost:8100/          landing
# http://localhost:8100/assets    register
```

Pages talk to the live Supabase project, so you are working against real data.
The two `/api` functions (SharePoint sync, admin user management) need
`vercel dev` and the environment below.

Tests for the shared logic:

```bash
cd scanner-app && npm test
```

## Environment

`.env.local` at the repo root, never committed:

| Key | Used by |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | public, also inlined in `js/supabase-client.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | admin API, e2e scripts. Bypasses RLS |
| `SUPABASE_DB_URL` | direct Postgres for scripts and migrations |
| `SUPABASE_ACCESS_TOKEN` | Management API (migration runner) |
| `CLIENT_SECRET` | Entra app, for Graph and the SharePoint sync worker |
| `SYNC_ACCESS_KEY` | shared secret the sync endpoint checks |

The Entra app (`pnp`, client `7caa51af-9f32-42d8-8264-da5b97c2f8eb`, tenant
`refrontiergroup.onmicrosoft.com`, `Sites.ReadWrite.All`) is used only by the
sync worker and the PowerShell scripts. Browsers never touch Microsoft.

## Operations

**SharePoint mirror.** Every insert, update and delete queues one row in
`sharepoint_sync` and fires an immediate HTTP call to the worker, with a
`pg_cron` sweep every 5 minutes as backstop. A row stops retrying after 5
attempts and shows as `failed` in **Admin > Sync health**, which is read only;
requeue with `requeue_failed_sync_rows()`. Bulk inserts are worth doing in
chunks so Microsoft Graph is not hit with a burst.

**Data health.** `Health-Check.ps1`, run monthly by
`.github/workflows/data-health.yml`, reports duplicate serials, missing tags
and serials, and assets unverified for 90 days, then files a GitHub issue.
It also warns when the automation certificate has under 90 days left. GitHub
disables scheduled workflows after 60 days of repo inactivity, so re-enable it
under Actions if it goes quiet.

**Deletes** are soft. Assets go to the recycle bin in `/admin` and can be
restored; purging is admin only and mirrors the delete to SharePoint.

**Backfills.** `backfill/` holds CSV work lists (missing prices, missing dates).
They carry employee names and serials and are gitignored.

## Gotchas

- Camera scanning needs a secure context. The Vercel URL and `localhost` both
  qualify; a LAN IP does not.
- Serial numbers have no uniqueness constraint and the add form does not check
  for duplicates. Placeholder serials (`0000`, `-`, `N/A`) and a handful of
  genuine duplicates exist. The monthly health check reports them.
- Asset tags are unique, enforced by a partial unique index on `lower(asset_tag)`
  for live rows. `item_id` is allocated server side by `next_asset_item_id()`.
- Some assets carry placeholder tags in the serial field while real tags are
  awaited. Scanning handles this by preferring tags, but reports should not
  assume a serial is a serial.
- `assets.json` and `assets.csv` under `scanner-app/` are local snapshots
  containing employee names. `.vercelignore` keeps them off the deployment.
- Motion respects `prefers-reduced-motion` on every page. Keep it that way when
  adding animation.
