# Migration Progress Log — SharePoint → Supabase

> Working document. Update after each phase. If something breaks, this is the map home.

## Target architecture

```
Apps ──▶ Supabase Postgres (source of truth)
              │ trigger: assets_to_outbox_*  → sharepoint_sync rows
              │ pg_net: instant poke + pg_cron: 5-min retry sweep
              ▼
   Vercel fn api/sharepoint-sync.js ──Graph API──▶ SharePoint list (mirror)
```

- One-way sync only. SharePoint = read-only mirror.
- Auth: Supabase email OTP replaces MSAL sign-in (Option A, user-approved).
- Idempotency: `SupabaseId` text column in SP list fingerprints every row.

## Credentials & config locations

| Secret | Location |
|---|---|
| Supabase DB pooler URL | `.env.local` → `SUPABASE_DB_URL` (password contains `#` — always percent-encode!) |
| Graph client secret (new, created today) | `.env.local` → `CLIENT_SECRET` |
| Supabase publishable key | `.env.local` → `SUPABASE_PUBLISHABLE_KEY` |
| Supabase service role secret | `.env.local` → `SUPABASE_SERVICE_ROLE_KEY` |
| Worker shared key | `.env.local` → `SYNC_ACCESS_KEY` (+ DB `app_config.sync_worker_key`) |
| Supabase URL | `.env.local` → `SUPABASE_URL` |

⚠️ NEVER commit `.env.local` (already gitignored). NEVER put service keys in browser code.

## Key identifiers

- Supabase project ref: `irqrnyixizzorvfmtvag` (region eu-west-1, pooler host `aws-1-eu-west-1.pooler.supabase.com`)
- Entra tenant: `refrontiergroup.onmicrosoft.com`, app `7caa51af-9f32-42d8-8264-da5b97c2f8eb`
- SP site id: `refrontiergroup.sharepoint.com,6e2871c3-cf14-4bbe-8d97-8da58f8b6e10,629c5972-9b75-4a1d-bb25-8179a335cc71`
- SP list "Xana Asset Inventory" id: `7d3b5f47-8199-4cb9-b7c4-361dc70c4622`
- Vercel project domain: `xana-assets.vercel.app` (`/scan`, `/assets`, `/dashboard`, `/api/*`)
- Local test harness dir: `%LOCALAPPDATA%\Temp\opencode\supabase-setup\`

## Completed ✅

1. **Schema live** — migrations applied via `apply-migration.js` harness:
   - `0001_initial_schema.sql` — tables `assets`, `sharepoint_sync`, `allowed_scanners`; outbox triggers; RLS policies
   - `0002_fix_delete_outbox_trigger.sql` — BEFORE DELETE trigger so delete ops capture `graph_item_id`
   - `0003_sync_dispatch_and_retry.sql` — pg_net dispatch on outbox insert, pg_cron job `sharepoint-sync-retry` (*/5), `app_config` table, `attempted_at` column
   - `0004_allow_processing_status.sql` — status check constraint now includes `processing`
2. **Backfill** — `scripts/backfill.mjs`: 111 items SharePoint→Supabase, counts verified, outbox suppressed. Repeatable/idempotent (upsert on `item_id`).
3. **Worker** — `api/sharepoint-sync.js` (NOT yet deployed): drains outbox → Graph create/patch/delete. Claim-based concurrency (`processing` + stale reset). Retry/backoff for 429/5xx/network. **NOT deployed to Vercel yet.**
4. **SP fingerprint** — `SupabaseId` column manually added by user (app lacks schema rights); all 111 existing items stamped with their `assets.id`.
5. **Local e2e v1 PASSED**: create→SP #124 ✓ update ✓ delete ✓ (before idempotency feature).

## Current known issues 🔧

1. ~~SupabaseId filter 400~~ ✅ RESOLVED — worker sends `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`; optional perf win: user ticks "Indexed" on column settings later.
2. ~~Orphan #125~~ ✅ deleted.
3. ~~Harness hang~~ ✅ fixed (`db2.end()` restored).
4. Harness cosmetic bug: TEST 4 dup-check query lacks Prefer header → always prints 0/"DUPLICATED". Ignore; real proof = `result:"adopted:<id>"`.
5. Optional: index SupabaseId via SharePoint UI for faster lookups as list grows (List settings → Columns → SupabaseId → Indexed).

## E2E v2 — ALL GREEN (2026-08-22) ✅

| Scenario | Result |
|---|---|
| INSERT → SP create (#126) | ✓ graph_item_id stored |
| UPDATE → SP patch (#126) | ✓ |
| DELETE → SP delete | ✓ |
| LOST-RESPONSE → adopt ghost (#127) | ✓ **no duplicate** |

## PRODUCTION LOOP — LIVE (2026-08-22) ✅

Worker deployed (commit `b7bb243`), env vars set on Vercel (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SYNC_ACCESS_KEY`).
Real chain verified with zero manual steps:

```
DB insert → outbox → pg_net → https://xana-assets.vercel.app/api/sharepoint-sync → SP #128 created (t+5s)
DB delete → delete op → SP #128 removed (t+5s)
```

Allowlist seeded: `allowed_scanners` = roystone@xanalife.com (from SP Scanner Access list).

## Revert / clean-state commands

```sql
-- see what's stuck
select op,status,attempts,left(coalesce(last_error,''),60) from public.sharepoint_sync order by created_at desc limit 20;
-- requeue everything after fixing a worker bug
select public.requeue_failed_sync_rows();
-- nuke test residue
delete from public.sharepoint_sync where payload->>'item_id' like 'SYNC-TEST%';
```
SharePoint orphans: find via `$filter=fields/Title eq '<name>'` then `DELETE /items/{id}`.

## RBAC + unified login rollout (2026-08-22)

- `0007_rbac_core.sql`: profiles · user_roles (admin/scanner/asset_viewer/dashboard_viewer) · has_role()/is_admin() · assets writes → role-based · RLS on profiles/roles
- `0008_app_choices.sql`: admin-managed dropdown lists (asset_type/status/location/region), seeded
- Admin auth account bootstrapped with all 4 roles (id f99f8c54…)
- `api/admin-users.js`: invite / set_roles / set_active / delete_user — verifies caller JWT + admin server-side; invite-only enforced client-side (`shouldCreateUser:false`)
- `/login` page: single sign-in for everything, lands users by strongest role
- All apps: inline OTP forms removed → redirect to /login; role gates per app; navbars filtered by roles
- Scanner: dropdowns now live from app_choices (cached offline)
- Dashboard: MSAL retired entirely — reads Supabase + computes summary client-side (port of computeSummary into adapter)
- Admin page rewritten: Users tab · Lists tab · Sync-health tab (shows pending/failed outbox rows)
- SharePoint Status/Location columns converted to plain text (user did in SP UI) so new choice values mirror freely

## Post-migration work (2026-09-03 and 2026-09-04)

The migration itself was done by this point. What follows is the first block of
work on top of it, grouped by theme.

### Access and roles

- **`asset_viewer` made genuinely view only.** RLS had always refused its
  writes, but `/assets` still rendered Scan, Add, inline edit, Verify, Clone
  and the USB wedge listener, so a viewer met failures instead of an honest
  read-only page. Now hidden at render, with `openAdd()` guarded at the single
  choke point. Verified end to end against a real `asset_viewer` account:
  26 checks, DB and UI.
- **New invites default to view only** (`asset_viewer` ticked, Scanner not),
  and the role grid resets on every open. It used to keep the previous
  invite's ticks, so an admin+scanner grant could ride onto the next person.
- **`0029_read_requires_role.sql`: reading requires an active role.** `assets`,
  `asset_history` and `asset_events` were readable by any signed-in account
  through PostgREST regardless of role, and a deactivated account kept that
  access. All six real accounts were checked before and after; a role-less or
  deactivated account now reads nothing.

### The CCTV batch

- **71 UniFi cameras added** across the six branches, from screenshots in
  `CAMERAS.pdf`. MAC as serial, canonical `AA:BB:CC:DD:EE:FF`, tags `XL-200`
  to `XL-270`, KES 30,400 each, 5 year life, so KES 431,680/yr of new
  depreciation. Script: `scripts/add-cameras.mjs`, dry-run by default, refusing
  duplicate or malformed MACs and unknown branches.
- **Branch purchase dates** taken from each site's existing assets, so cameras
  depreciate in step with the rest of the kit: Syokimau 2025-09-01, Ruiru
  2026-06-05, TRM Dr and Lumumba Dr 2026-07-02, Githurai 2026-05-15, Katani
  2025-12-01 (the last two supplied by IT; those branches had no dated assets).
- **Custodians.** The batch first went in with a blank `employee`, which made
  all 71 count as idle stock on the dashboard (73 assets, KES 1.9M, "redeploy
  before buying new"). The estate labels fixed infrastructure with a custodian,
  so cameras took `<Branch> CCTV` and idle stock fell back to 2.

### Depreciation

- **`0027_choice_useful_life.sql`: useful life moved into `app_choices`.** It
  was a hardcoded JS map, so a type added in Admin silently inherited the 3
  year "Other" default and only a deploy could fix it. Editable per type in
  Admin now, seeded from the map, which stays as the fallback.
- **Depreciation CSV reconciles.** Accumulated was counted in whole months
  while closing book value came from fractional-year ageing, so cost minus
  accumulated never equalled the closing value. Both now come from one engine.

### Features and fixes

- **Asset events wired up.** The table, RLS and form had existed since 0017
  but nothing ever called the form, so nothing could be logged. Issues,
  repairs, maintenance, transfers and notes with costs can now be recorded,
  left open, and closed.
- **Scanning prefers the tag over another asset's serial.** Placeholder tags
  currently sit in some serial fields, so scanning `XL-94` could open the
  asset whose *serial* was XL-94. Two-pass lookup, covered by a test.
- **Admin Lists rebuilt.** Five sequential queries became one, categories are
  collapsible with counts and a filter, values show how many assets use them,
  removal asks first, and Departments is manageable at last (it had been a
  valid category since 0012 with no UI).
- **Status colours.** In Repair rendered green on the register (no branch in
  `statusColor`) and blue on the dashboard (the map keyed "Under Repair", not
  the live value). Both fixed; Lost split to a distinct red; Under
  Investigation given its own colour.
- **Motion and loading.** Shared `.page-boot` overlay, cross-page view
  transitions, skeletons in place of "Loading…" text in Admin. Two bugs
  surfaced: `--ease-out` was undefined on `/` and `/login`, silently killing
  every shared transition there, and the dashboard's boot overlay had no
  opacity rule so it never faded.
- **`.gitignore`** never actually ignored `backfill/*.csv`: the pattern had a
  leading space. Those files carry employee names and serials.

### Data quality found and left open

- 90 of 228 assets have no purchase price (112 flagged estimate pending), so
  the register's stated value covers roughly 60% of the estate. Work list:
  `backfill/missing-purchase-price-2026-09-04.csv`.
- 16 Syokimau assets still have no purchase date, so they never depreciate.
- Three genuine duplicate serials, plus placeholder serials (`0000`, `-`,
  `N/A`) on 28 rows.

## Remaining roadmap

- [x] Site URL + uri_allow_list fixed via Management API (was localhost) — emailed links now land correctly
- [x] App update deployed: clicking an emailed magic link signs the user in automatically
- [x] Custom SMTP via API — **live (2026-08-28), via Office 365.** Mailgun was ruled out entirely (no GoDaddy access for `xanalife.com`, ever — even the Cloudflare-NS-delegation path needed one GoDaddy touch). Office 365 needed zero new DNS since `xanalife.com` mail was already verified there. Roystone (IT lead) created a Shared Mailbox `noreply@xanalife.com`, licensed it, unblocked sign-in, and enabled SMTP AUTH for it directly (`Set-CASMailbox -Identity noreply@xanalife.com -SmtpClientAuthenticationDisabled $false`) — no Conditional Access block hit. `scripts/set-smtp-and-template.mjs` pushed `smtp.office365.com:587` + both branded templates (`scripts/email-templates/magic-link.html`, `scripts/email-templates/invite.html`) in one call; verified live via `node scripts/check-auth-config.mjs` and a real end-to-end test magic-link send to roystone@xanalife.com — arrived branded, from `Xana Asset System <noreply@xanalife.com>`, not Supabase's default. Invite template uses the same SMTP path so should work identically — worth a real test send from `/admin` next time someone's actually invited, just to confirm.
- [x] Sign-in card: magic link is the sole front-door action; password is now a "didn't get the email?" fallback surfaced after sending the link, not a top-level tab (`index.html`)
- [ ] USER ACCEPTANCE: sign-in at /login · invite a colleague from /admin · verify role gating · scan an asset · confirm it mirrors to SharePoint
- [ ] Optional cleanup: index SupabaseId column (SP UI) · delete old MSAL lib files · retire api/summary.js once dashboard confirmed stable
- [ ] Monitor outbox 1 week
