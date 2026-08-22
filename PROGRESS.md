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

## Remaining roadmap

- [ ] Deploy worker: git push → Vercel; add env vars SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SYNC_ACCESS_KEY (values in .env.local)
- [ ] Verify cron retry fires (outbox pending row drains within ~5 min without manual call)
- [ ] Phase 5a: `js/supabase-client.js` (publishable key, OTP auth helper)
- [ ] Phase 5b: scanner-app refactor (OTP sign-in; supabase reads/writes; keep offline queue; allowlist → `allowed_scanners` table; seed admin `roystone@xanalife.com` + current scanners)
- [ ] Phase 5c: assets app same treatment
- [ ] Phase 6: WRITE_BACKEND flag cutover, monitor 1 week, remove MSAL remnants, retire/retarget api/summary.js
