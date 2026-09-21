# ADR-006: Writes require an active profile; anonymous paths closed

## Status
Accepted, live 2026-09-20 (`0036_security_hardening.sql`, root `.vercelignore`)

## Date
2026-09-20

## Context

ADR-004 made *reading* the register require an active role. A read-only audit of
the live project on 2026-09-20 found four ways the authorization model still did
not hold, each verified before it was changed rather than inferred from the code:

1. **`asset_extra_merge` was callable with the publishable key alone.**
   `POST /rest/v1/rpc/asset_extra_merge` returned HTTP 204 with no session.
   The function is `SECURITY DEFINER`, its owner is also the owner of
   `public.assets`, and that table is not `FORCE ROW LEVEL SECURITY` — so the
   `assets` UPDATE policy it was assumed to rely on never ran. The file's own
   comment (`0010:17`) claimed the opposite. `next_asset_item_id` and
   `requeue_failed_sync_rows` had the same default-`PUBLIC` EXECUTE grant; only
   `touch_last_seen` had ever revoked it.
2. **Both storage buckets could be listed anonymously.** The SELECT policies
   were `to public`, and Storage's object LIST route honours them:
   `POST /storage/v1/object/list/it-documents` returned the real filenames of
   the internal IT forms, and `asset-images` returned its `item_id` folders.
3. **Deactivation revoked reads but not writes.** `has_app_role()` (0029) gates
   reads on `profiles.active`, while `is_allowed_scanner()` (0007) is just
   "holds scanner|admin" — and deactivating an account leaves its `user_roles`
   rows. Four auth accounts left over from the August harness runs had no
   `profiles` row at all, so `/admin` could not even display them, yet two still
   held `scanner` and could write to the register through PostgREST.
4. **The recycle bin was admin-only on paper only.** 0020 restricted the hard
   `DELETE`; the path the UI uses is a soft delete, i.e. an ordinary
   `UPDATE deleted_at`, which the scanner update policy allows.

Separately, the deployment served the whole repository: `xana-assets.vercel.app/HANDOFF.md`
returned the runbook (tenant ids, Entra client id, cert thumbprint, admin
emails), `/supabase/migrations/*.sql` returned the schema and RLS, and
`/scanner-app/test/fixtures/assets.json` returned employee names with serials.
The only `.vercelignore` in the repo sat inside `scanner-app/`, and Vercel does
not apply a subdirectory's ignore file.

## Decision

1. **Every mutating RPC carries its own role gate and loses its anonymous
   grant.** `asset_extra_merge` re-checks `is_super_admin() or
   is_allowed_scanner()` inside the body (a `SECURITY DEFINER` body is not
   subject to RLS, so the check has to be explicit), and `revoke execute … from
   public, anon` is applied to it, `next_asset_item_id`,
   `requeue_failed_sync_rows` (service role only) and
   `prune_operational_history`.
2. **Write access requires an active profile.** `is_allowed_scanner()`,
   `is_admin()` and `is_super_admin()` now include `has_app_role()` — the same
   predicate reads use. This extends ADR-004 to the write side.
3. **Lifecycle and identity fields are guarded by triggers, not by policy
   wording.** `profiles.active` / `profiles.email` are administrator-managed
   (the self-update policy in 0009 granted every column, so a deactivated
   account could set `active = true` and undo 0029); `assets.deleted_at`
   transitions require admin. Both fall through to permissive for direct SQL
   and for `service_role`, which is the same split the app already relies on.
4. **Storage: public object URLs are allowed, anonymous listing is not.**
   `asset-images` stays public because the detail card's `<img>` needs a
   session-free URL (ADR-002); its SELECT policy is now `to authenticated`, both
   buckets have size and MIME limits, and `it-documents` — internal forms — is
   private and read through short-lived signed URLs.
5. **The deployment never serves repository files.** A root `.vercelignore`
   excludes docs, migrations, scripts, CI config, cert material and test
   fixtures; the app's own assets are unaffected.
6. **The legacy allowlist is dropped.** `allowed_scanners` kept a
   `using (true)` read policy after 0007 stopped using it, so it only leaked the
   old scanner email list.

## Consequences

- Deactivating an account now revokes reads **and** writes, and the account
  cannot re-enable itself. This is the behaviour `/admin` always implied.
- Role rows belonging to an account with no `profiles` row are deleted
  (migration 0036): such an account can never be shown or revoked from
  `/admin`, so its roles were unmanageable by construction.
- Readers keep the same experience: `asset_viewer` can read everything and
  write nothing, enforced in Postgres (27/27 checks in
  `scripts/e2e-view-only-test.mjs`).
- Scripts that use the service key are unaffected — `service_role` inherits
  EXECUTE through `authenticated` for the RPCs above, and bypasses RLS.
- **Residual, accepted:** `asset-images` object URLs are still fetchable by
  anyone who knows the path, and paths are `item_id`-based (enumerable). Making
  that bucket private means moving every `<img>` to a signed URL; the photos
  themselves expose labels and serials, so this is the next thing to fix if the
  register ever holds something more sensitive.
- **Residual, not yet actioned:** the GitHub repository itself is public, so
  the same documents remain readable there; closing that is the owner's
  visibility decision, not a code change. Deployments created before this date
  are immutable and keep serving whatever they were built with — they have to
  be deleted in the Vercel dashboard.

## Verification

Read-only probes against the live project, before and after:
`anon` refused (401 `42501`) on all three RPCs, `anon` listing both buckets
returns `[]`, the known `it-documents` object URL returns 400, a scanner can
still merge extras and allocate an id, a viewer cannot, a deactivated scanner
writes 0 rows, a scanner cannot bin an asset, an admin can,
`profiles.active` self-change is refused while `must_change_password` still
clears, and `service_role` is unaffected. 22/22 RLS+anon checks, 29/29
migration behaviour checks, 10/10 real-API checks, 27/27 view-only e2e.

## Alternatives considered

- **`ALTER TABLE assets FORCE ROW LEVEL SECURITY`.** The stronger structural
  fix: it would make the definer functions subject to the table's policies
  instead of relying on a hand-written gate inside each body. Rejected for now
  because it changes behaviour for every definer function at once (including
  the allocator and the audit/outbox triggers) and would need a full pass over
  every policy's `USING`/`WITH CHECK` to keep the sync worker and scripts
  working. Worth doing deliberately, with the app as the only consumer.
- **Making `it-documents` public-but-unlisted.** Half a fix: the object URLs
  stay enumerable-by-guessing, which is exactly how the forms leaked.
- **Leaving the repo files served and relying on obscurity.** The URLs were
  guessable and are documented in the repo's own README.
