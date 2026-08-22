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
- Vercel project domain: `asset-system-tau.vercel.app` (`/scan`, `/assets`, `/dashboard`, `/api/*`)
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
DB insert → outbox → pg_net → https://asset-system-tau.vercel.app/api/sharepoint-sync → SP #128 created (t+5s)
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

## Remaining roadmap

- [ ] Commit + push RBAC batch → deploy → live smoke tests (invite flow, role gating, choices)
- [ ] Optional cleanup: index SupabaseId column · delete old MSAL libs · retire api/summary.js once dashboard confirmed stable
- [ ] Monitor outbox 1 week
