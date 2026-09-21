# ADR-007: Mirror retry, bin semantics and retention

## Status
Accepted, live 2026-09-20/21 (`0038_data_integrity.sql`, `0041_outbox_delete_identity.sql`,
`api/sharepoint-sync.js`, `scripts/reconcile-mirror.mjs`)

## Date
2026-09-21

## Context

The SharePoint mirror is fed by an outbox (`sharepoint_sync`) that a Vercel
function drains. Three properties of that pipeline turned out to be
assumptions rather than behaviours, all measured on the live project:

1. **A `failed` row was never retried.** The cron sweep and the worker both
   claim `status = 'pending'` only (0003's header claimed pending *and* failed).
   After five attempts a row is parked as `failed`, so a Graph or credential
   outage lasting ~25 minutes stopped mirroring permanently, and the only
   surface was an admin who happened to open Sync health. Worse,
   `requeue_failed_sync_rows()` reset `status` but not `attempts`, so one
   requeue bought exactly one attempt before the row flipped straight back.
2. **The bin was invisible to the mirror.** `0019`'s comment says a soft-deleted
   asset is mirrored as deleted; nothing implemented it, because the trigger
   copies field values and the mirror has no lifecycle column. A binned asset
   kept its live `Status` in SharePoint, and `restore` was a no-op too.
   `asset_history` was equally blind: `deleted_at` was not in the audit
   trigger's tracked list, so "who binned this" had no answer.
3. **Deletion could leak an orphan forever.** `sharepoint_sync.asset_id` is
   `references assets(id) on delete set null`, and the FK nulls it immediately
   after the BEFORE DELETE trigger writes the row — so a delete row carries no
   asset link (31/31 measured). If the asset also had no `graph_item_id`, the
   worker had nothing to look the SharePoint item up by and completed with
   `nothing-in-sp`. `scripts/reconcile-mirror.mjs` found four such orphan items
   in production on its first run.
4. **`done` rows accumulated forever** (1,567 in four weeks) with no pruning,
   and `asset_history` had no policy either.

## Decision

1. **Retry policy: 5 attempts to `failed`, then bounded automatic revival.**
   The worker keeps claiming `pending`. A new cron job
   (`sharepoint-sync-requeue`, every 15 minutes) flips `failed` rows back to
   `pending` while `attempts < 20`; a manual `requeue_failed_sync_rows()` resets
   `attempts` and `last_error` entirely and is the escape hatch after 20.
   Rationale: an outage self-heals without a human, a permanently broken row
   stops consuming Graph budget, and the counter distinguishes "transient" from
   "needs a person".
2. **The bin is represented by removing the mirror row.** An outbox `update`
   for an asset with a non-null `deleted_at` deletes its SharePoint item while
   keeping `graph_item_id`; restoring it makes the next PATCH 404, which clears
   the stale id and re-creates the item. SharePoint therefore shows exactly what
   the register shows, and the mirror count matches the live asset count.
3. **Deletes carry their own identity.** The delete branch of
   `assets_to_outbox()` snapshots `{asset_id, item_id}` into `payload`, which has
   no FK and cannot be nulled. The worker resolves the fingerprint from
   `row.asset_id || payload.asset_id`, so a delete can always find the SharePoint
   item. Rows written before this carry only a breadcrumb in `last_error`.
4. **A Graph 404 is recoverable, not fatal.** On PATCH 404 the worker clears
   `graph_item_id` and re-creates the item in the same attempt; on DELETE 404
   the desired end state already holds and the row completes with a note.
   Duplicate fingerprint matches are collapsed to one item.
5. **Retention: outbox 90 days automatically, audit kept.** A monthly cron
   deletes `done` outbox rows older than 90 days. `asset_history` is retained
   indefinitely (it is the audit trail) and is only removed deliberately via
   `prune_operational_history(p_outbox_days, p_audit_days)`.
6. **Drift is a first-class check.** `scripts/reconcile-mirror.mjs` compares
   the two stores (orphan SharePoint items, assets whose mirror id is missing,
   duplicate ids, stale binned rows, count delta), exits non-zero on drift, and
   offers `--clean-orphans` (dry-run by default) for items whose `SupabaseId`
   belongs to an asset that no longer exists.

## Consequences

- Steady-state mirroring survives a credential or Graph outage of any length
  short of 20 attempts; a genuinely broken row parks itself and says so.
- Binned assets disappear from SharePoint, which is what an exec reading the
  list expects, but it means the mirror is no longer a "full history" view:
  the register (Supabase) is the only place a binned asset exists. This matches
  ADR-001's position that SharePoint is a mirror, not a record.
- Restoring a binned asset costs a Graph POST (re-create) rather than a PATCH.
- `reconcile-mirror.mjs` and the retention job are the operational answer to
  "is the mirror right?" — they are manual/monthly rather than per-change,
  because a per-change comparison would double the pipeline's API calls.
- Rows that failed before this change keep their old `last_error` text; the
  breadcrumb is a hint, not a record.

## Verification

29/29 migration probes (allocator monotonicity, choice guard, bin audit,
event attribution, requeue reset, retention jobs, storage privacy) and the
mirror e2e (`scripts/e2e-scan-mirror-test.mjs`: insert → outbox → pg_net →
worker → Graph → update → delete) against production. `reconcile-mirror.mjs`
now reports the four legacy orphans explicitly instead of leaving them
invisible.

## Alternatives considered

- **Retry `failed` rows on the 5-minute sweep with no cap.** Simple, but a
  permanently broken row (revoked permission, deleted list) would burn requests
  forever with no signal. The bounded revival keeps the self-healing property
  and adds a stopping condition.
- **A `Deleted` marker column in the SharePoint list.** Keeps a binned row
  visible, but the mirror's columns are hand-maintained (the app has no schema
  rights in that tenant) and every reader — Power Apps, execs, the monthly
  health report — would have to learn to filter on it. Removing the row is the
  honest representation of "not in the register".
- **Keying `sharepoint_sync` to `item_id` instead of the uuid.** Would have
  survived the cascade, but the uuid is what the SharePoint `SupabaseId`
  fingerprint carries; `payload` preserves it without touching the schema.
