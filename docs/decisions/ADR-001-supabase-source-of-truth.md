# ADR-001: Supabase Postgres as source of truth, SharePoint as read-only mirror

## Status
Accepted — live 2026-08-22 (worker deployed `b7bb243`, 781 sync `done`)

## Date
2026-08-22

## Context
Refrontier Group ran the **Xana Asset Inventory** entirely in a SharePoint Online list (`7d3b5f47-8199-4cb9-b7c4-361dc70c4622`). SharePoint was the master, accessed via MSAL + Graph. Pain:

- Throttling and Graph auth refresh redirects broke floor scans.
- No offline mode — Syokimau/Ruiru stock-takes failed without signal.
- No audit trail beyond `versions` (no `who changed purchase_price`).
- MSAL libraries and `api/summary.js` server round-trips added latency and Vercel cost.
- Role control was SharePoint groups, not database RLS — difficult to enforce per-field.

Requirements for replacement:

- Relational model (assets, history, events, choices, sync outbox) with ACID + RLS.
- Offline-first reads/writes for floor staff.
- One-way mirror to SharePoint must be kept for execs who still open the list.
- Idempotency (lost-response → no duplicate `SupabaseId`).

## Decision
Make **Supabase Postgres `irqrnyixizzorvfmtvag` (eu-west-1)** the source of truth. SharePoint becomes a **read-only mirror** via `sharepoint_sync` outbox.

Flow:

```
Apps → Supabase Postgres → AFTER trigger assets_to_outbox_* → sharepoint_sync (pending)
                              │ pg_net immediate POST + pg_cron 5-min retry
                              ▼
                         api/sharepoint-sync.js → Graph API → SP list (SupabaseId = assets.item_id)
```

* Auth: Supabase email OTP/password, invite-only, roles `super_admin, admin, scanner, asset_viewer, dashboard_viewer` in `user_roles` + `allowed_scanners`. RLS: `has_role()`, `is_admin()`, `is_super_admin()`.
* Idempotency: `SupabaseId` text column in SP list, worker `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`, `adopted:<id>` on duplicate.

## Alternatives Considered

### Keep SharePoint as master, cache in Supabase
- Pros: No migration, SP remains familiar.
- Cons: Still subject to Graph throttling/auth; offline writes still need Graph; audit still weak.
- Rejected: Does not solve reliability or offline.

### Two-way sync (bidirectional)
- Pros: Edits in SP reflect in Supabase.
- Cons: Conflict resolution complex; SP column renames break mapping; doubles outbox complexity.
- Rejected: SP declared read-only — simpler, safe.

### Firebase / MongoDB as master
- Pros: Real-time, free tier.
- Cons: Our data is relational (assets ↔ history ↔ events ↔ choices); need transactions for `item_id` allocation (`next_asset_item_id()`); team already knows Postgres; RLS + `pg_net` + `pg_cron` are Postgres-native.
- Rejected: Postgres fits relational + sync primitives.

## Consequences
+ Full RLS, `asset_history` and `asset_events` audit, `next_asset_item_id()` numeric max+1 (fixes client-side `ORDER BY` on TEXT).
+ Offline cache/queue (`xana_data_cache_v1`, `xana_write_queue_v1` 50 cap) — floor scans survive.
+ `pg_net` immediate + `pg_cron` retry = <5s mirror latency, observed `INSERT → SP #128 in 5s`.
+ Vercel worker is stateless, claim-based concurrency (`processing` + stale reset), 429/5xx backoff.
- SharePoint can no longer be edited — must train execs to use `/dashboard`. Migration `0001..0022` must be applied via `apply-migration.mjs` (DB_URL password `#` → `%23`).
- Old Vercel deployments at immutable URLs still served `assets.csv` — must delete manually.

## Verification
* E2E v2 all green: INSERT→SP create, UPDATE→patch, DELETE→delete, LOST-RESPONSE→adopt ghost (no duplicate) — `PROGRESS.md`.
* Live: `select count(*) from sharepoint_sync where status='pending'` → 0.

## References
* `supabase/migrations/0001_initial_schema.sql` .. `0022_unique_asset_tag.sql`
* `api/sharepoint-sync.js`, `PROGRESS.md`, `HANDOFF.md`
