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

## Dead code removal (2026-09-14)

- **Migration `0034` applied (HTTP 201):** unused `Desktop` asset type removed from the Admin dropdown (zero live assets; guarded re-runnable). `USEFUL_LIFE_BY_TYPE.Desktop` stays as a depreciation fallback. Legacy `ASSET_TYPE_CHOICES` fallbacks in `logic.js` + `assets/index.html` updated to match.
- **Deleted:** `labels/` QR generator (`asset-labels.html`, `make-labels.mjs`, `package.json`, 164KB — nothing referenced it; local `assets.json` snapshot stays on disk, gitignored) and the deprecated `Add/Remove-BarcodeColumn.ps1` (column gone since Aug 2026). All recoverable from git history; HANDOFF inventory updated.

## Employee name consolidation (2026-09-14)

- **Migration `0033` applied (HTTP 201):** 15 rows across approved groups B (Githurai typos), C (Liquour typo), D (Lumumba Drive majority), F (Server Romm typo), G (till case/spacing, branches preserved). Old variants verified at 0, zero sync failures.
- Rejected in review and untouched: A (Deli Ruiru vs Deli Syokimau are distinct counters), E (Pharmacy Syokimau), H (TRM Pharmacy).

## Model name consolidation, pass 2 (2026-09-14)

- **Migration `0032` applied (HTTP 201):** 7 rows — `Hp Desktop 290 G9` + `HP Pro Tower 290 G9` into `HP Pro Tower 290 G9 Desktop PC` (now 8), `400 G9 PCI Desktop` into `... Desktop PC` (now 3), `TPA-P001K` into `HP TPA-P001K` (now 3), `HP TPAP001M` hyphen fix into `HP TPA-P001M` (now 2), `CD36030U00` into `CD-3603U-B` (now 10). Old variants verified at 0, zero sync failures.
- Untouched per review: RP31/32, `HP Pro Tower 290` + `290 E PCI` (generation unconfirmed), `HP TPAD001M` vs `TPA-D005K`, `CD07I132`, P24 monitor family, bare-brand models.

## Model name consolidation (2026-09-14)

- **Migration `0031` applied (HTTP 201):** 5 typo-level merges, 8 rows — `Brother-QL820NWB` to `Brother QL-820NWB`, `HP HP Pro Tower 290 G9 Desktop PC` (doubled prefix) to single-HP, `DEL DELL P2419H` to `DELL P2419H`, `Hp TPA-L001K` case fix, `HPN HP 322pv` stray-N fix. Old variants verified at 0 after apply. Mirror drained via outbox (no failures).
- Types, statuses, locations, departments already clean — no variants left. Ambiguous SKU groups (P24 monitors, 290 vs 400 towers, RP31/32, CD-3603U-B vs CD36030U00, TPA-D/P printers) left for IT eyeball.

## Serial duplicate guard (2026-09-14)

- **`isPlaceholderSerial` + `findSerialCollision` in `scanner-app/logic.js`** (tested, 49/49): placeholders (`0000`, `-`, `N/A`, blanks) never collide; everything else checks serial-vs-serial then serial-vs-tag (tags win scans, so a serial matching another asset's tag is a routing trap).
- **`/assets` add form:** live orange warning while typing + hard block on save, including bundle component rows and within-bundle dupes.
- **`insertAsset()`:** 23505 retry narrowed to `item_id` races only; serial/tag collisions surface immediately with a plain-language error.
- **Migration `0030` applied (HTTP 201):** index build SKIPPED by design — 3 genuine dupe groups still live (`312023090012` XL-97/XL-99, `9cp541rlnv` XL-17/XL-94, `xl-98` XL-134/XL-172). Resolve those rows, re-run the file (`if not exists` = safe no-op once clean). 4 tag-collision rows (XL-131/132/133/171) stay frontend-only.

## Remaining roadmap

- [x] Site URL + uri_allow_list fixed via Management API (was localhost) — emailed links now land correctly
- [x] App update deployed: clicking an emailed magic link signs the user in automatically
- [x] Custom SMTP via API — **live (2026-08-28), via Office 365.** Mailgun was ruled out entirely (no GoDaddy access for `xanalife.com`, ever — even the Cloudflare-NS-delegation path needed one GoDaddy touch). Office 365 needed zero new DNS since `xanalife.com` mail was already verified there. Roystone (IT lead) created a Shared Mailbox `noreply@xanalife.com`, licensed it, unblocked sign-in, and enabled SMTP AUTH for it directly (`Set-CASMailbox -Identity noreply@xanalife.com -SmtpClientAuthenticationDisabled $false`) — no Conditional Access block hit. `scripts/set-smtp-and-template.mjs` pushed `smtp.office365.com:587` + both branded templates (`scripts/email-templates/magic-link.html`, `scripts/email-templates/invite.html`) in one call; verified live via `node scripts/check-auth-config.mjs` and a real end-to-end test magic-link send to roystone@xanalife.com — arrived branded, from `Xana Asset System <noreply@xanalife.com>`, not Supabase's default. Invite template uses the same SMTP path so should work identically — worth a real test send from `/admin` next time someone's actually invited, just to confirm.
- [x] Sign-in card: magic link is the sole front-door action; password is now a "didn't get the email?" fallback surfaced after sending the link, not a top-level tab (`index.html`)
- [ ] USER ACCEPTANCE: sign-in at /login · invite a colleague from /admin · verify role gating · scan an asset · confirm it mirrors to SharePoint
- [ ] Optional cleanup: index SupabaseId column (SP UI) · delete old MSAL lib files · retire api/summary.js once dashboard confirmed stable
- [ ] Monitor outbox 1 week

## Security + correctness pass (2026-09-20)

Full audit first (5 parallel read-only scans of the pages, the API functions,
the migrations, the pipeline and the docs), then the fixes below. Every claim
here was checked against the live project with a read-only probe before and
after, not inferred from the docs.

### Exposure: the production domain served the whole repo

Verified live before the fix, with no session:

| URL | Result |
|---|---|
| `/HANDOFF.md` | 200, 18,550 bytes |
| `/supabase/migrations/0007_rbac_core.sql` | 200 |
| `/docs/IT_Manager_Handoff.md` | 200, 11,319 bytes |
| `/scripts/backfill.mjs` | 200 |
| `/scanner-app/test/fixtures/assets.json` | 200, employee names + serials + SharePoint URLs |

Leaked: tenant/Entra ids, cert thumbprint, admin emails, full schema and RLS,
staff names. The only `.vercelignore` sat in `scanner-app/` and Vercel does not
apply a subdirectory's ignore file. `.env.local` and `package.json` correctly
404'd (`.gitignore`, not the ignore file, as the docs claimed).

- **Added a root `.vercelignore`** covering `*.md`, `docs/`, `references/`,
  `supabase/`, `scripts/`, `backfill/`, `labels/`, `images/`, `.github/`,
  `.hermes/`, `.claude/`, `.agents/`, `.opencode/`, `*.ps1`, cert material,
  `.env*`, `scanner-app/test/` and the local snapshots. The two `curl` commands
  to verify are in the file's header. **Deployments created before this are
  immutable and still serve those files** — deleting them in the Vercel
  dashboard is still open.

### Migration `0036_security_hardening.sql` (applied, HTTP 201)

Verified before: `POST /rest/v1/rpc/asset_extra_merge` with only the publishable
key returned **HTTP 204**; `pg_proc` showed `anon` EXECUTE on it, on
`next_asset_item_id` and on `requeue_failed_sync_rows`; the function owner is the
`assets` owner and `assets` is not FORCE ROW LEVEL SECURITY, so the `SECURITY
DEFINER` body ran with no RLS and no role check — the opposite of what
`0010:17`'s comment claimed. `POST /storage/v1/object/list/it-documents` (anon)
returned the real filenames of the internal IT forms; `asset-images` listed its
`item_id` folders. Four auth accounts from the Aug-22/23 harness runs
(`e2e-test+`, `pwd-test+`, `audit5+`, `del-test+`) had no `profiles` row — so
`/admin` cannot show them — and two still held `scanner`, i.e. write access.

- `asset_extra_merge` keeps its definer body but gates the caller
  (`is_super_admin() or is_allowed_scanner()`, service_role and no-claims SQL
  pass); `revoke execute … from public, anon` on it, on `next_asset_item_id`
  (keep `authenticated`) and on `requeue_failed_sync_rows` (service_role only).
- Storage SELECT policies are no longer `to public`: `asset-images` needs a
  signed-in account (the app's `.list()` calls still work; public object URLs
  are untouched, so `<img>` still renders), `it-documents` needs an admin.
  Residual and deliberate: a known `it-documents` URL still resolves because the
  bucket is public — making it private means moving `/admin` to signed URLs.
- `is_allowed_scanner()`, `is_admin()` and `is_super_admin()` now require an
  active profile (`has_app_role()`), closing the reverse of 0029: deactivation
  used to revoke reads but leave writes. Role rows for profile-less ghost
  accounts were deleted.
- `profiles`: a BEFORE UPDATE trigger refuses self-service changes to `active`
  and `email` (must_change_password and last_seen still work — `touch_last_seen`
  and `completePasswordChange` were both re-checked).
- `assets`: a BEFORE UPDATE trigger requires admin for any `deleted_at`
  transition (0020 only covered the hard delete).
- Dropped `allowed_scanners`' `using (true)` read policy (superseded in 0007,
  it only exposed the legacy email list).

### Migration `0037_representation_hygiene.sql` (applied, HTTP 201)

- `extra.purchase_price`: 92 rows were JSON strings (add sheet writes the text
  input through) against 42 numbers (inline editor sends `Number()`). All 92
  were plain digits; normalized to numbers so `jsonb_typeof`, ordering and any
  future SQL aggregate agree. The 90 rows with no price are untouched.
- 27 transfer/move events logged before `addAssetEvent` learned that only
  issues stay open were still `resolved=false` and sat in the IT open-issue view
  forever. Closed.

### `/assets` fixes (verified-live bugs)

- **The detail card went stale on every save.** `load()` only re-rendered the
  card when the URL carried `?id=`, and `viewToUrl()` stripped `id` on the first
  render — edit Status and the row said Retired while the pill still said In Use;
  Book Value / Dep Status / Last Verified never updated either. The card is now
  re-rendered from the reloaded register after a save, `?id=` survives
  `viewToUrl()` (so Copy link reproduces an open card) and `closeDetail()` drops
  it.
- **Audit mode silently ignored assets** whose Location carries stray
  whitespace: `auditExpected()`, the branch counts and the scan-time scope check
  compared raw values while the dropdown used trimmed ones. All three now share
  one trimmed comparison.
- **Walk mode rewrote LastVerified on a loop.** A barcode left in the camera's
  view re-decoded every ~1.5 s and every decode wrote a verification (one
  `asset_history` row + one SharePoint sync row each). A repeat scan in the same
  pass still counts as a hit; it no longer writes.
- **Hit/Miss counters were tab-lifetime** while the Found/Missing stats beside
  them reset per branch; both now reset on walk-mode entry and on branch change.
- **One physical scan could run twice** (decoder fires per frame, `stopScan()` is
  async): a latch now drops the second decode.
- **The Purchase column sorted on a key no row has** (`purchase`), so clicking it
  did nothing; it sorts on `purchaseDate` and unknown `?sort=` values from old
  links are ignored.
- **Editing bounced the table to page 1** on every save (`applyFilters` reset
  `currentPage`); the refresh after a save keeps the page, filter changes still
  reset, and the page is clamped to the surviving rows.
- **The People view hijacked the register**: two `input` listeners on `#search`
  meant each keystroke also re-filtered and re-rendered the hidden register *and*
  wrote the person's name into the URL filter set (breaking Copy link / Export
  view). One dispatcher now decides per view.
- **Asset Type dropdown listed every type twice** — the fallback ran
  synchronously before the `app_choices` fetch resolved, and bundle rows copy
  `#addType.innerHTML`. The fallback now runs after the fetch and only when it
  returned nothing. The `getChoices()` fallback lists were also stale (offered
  `Desktop`, deleted by 0034, and lacked `Camera`); they now mirror live
  `app_choices`.

### `js/supabase-client.js`

- **A write that changed nothing reported success.** `updateAsset`,
  `restoreAsset` and `purgeAsset` ignored affected rows, and PostgREST answers
  204/200 with zero rows and no error when RLS filters the row out — a read-only
  role or an expired session produced "Saved ✓" over an unchanged asset. They
  now `.select("item_id")` and raise a plain-language error when nothing was
  written.
- Tag/serial unique violations are translated on the **update** path too (they
  were only translated on insert), and restoring a binned asset whose tag has
  since been reissued now says so instead of printing a raw 23505.
- **Placeholder serials** ("0000" only) now use the canonical list
  (`0000`, `-`, `n/a`, blank) that `logic.js` and 0030's index predicate define,
  so duplicate checks, health counts and deep links agree.
- `landingFor()` returned `/scan`, which 308-redirects to `/assets` — scanners
  took a pointless extra hop on every sign-in. Nav allow-map updated to match.
- `mustChangePassword()` still fails open by design, but a failed check is now
  logged instead of silent.

### Tooling

- **`scripts/check-syntax.mjs`** parses the inline `<script>` blocks of all five
  pages plus `js/`, `summary/app.js`, `scanner-app/*.js`. Nothing parsed them
  before — a typo there shipped with a green CI check. Run it before pushing;
  adding it as a CI job still needs a push token carrying the `workflow` scope
  (the current PAT is rejected when a commit touches `.github/workflows/`),
  which is why it is a script and not a workflow step yet.
- **`scripts/check-guards.mjs`** asserts the security posture directly against
  the database (no `anon`-executable RPCs, no PUBLIC storage policy, guard
  triggers present, tag index present, serial index reported, event/price
  hygiene) so a guard can never silently skip again — the 0030 lesson.

### Verification (this pass)

- `node scripts/check-syntax.mjs` → all files parse; `npm --prefix scanner-app test` → 59/59.
- RLS + anonymous probe (rolled-back transactions, live project): **22/22** —
  scanner can merge extra, viewer cannot, deactivated scanner writes 0 rows,
  scanner cannot soft-delete, admin can, `profiles.active` self-change refused,
  `service_role` unaffected, and `anon` refused on all three RPCs and both
  storage listings.
- Real API path with a temporary scanner account (created and deleted by the
  probe, `Prefer: return=representation` exactly as the adapter sends):
  **9/9** — PATCH returns the row, a write to a missing asset returns 0 rows,
  soft delete is refused with 42501, merge and id allocation still work.
- `node scripts/e2e-view-only-test.mjs` → **27/27** (reader role unchanged).
- `node scripts/check-guards.mjs` → all guard checks pass; serial index still
  reported missing (see below).

### Still open after this pass (needs a decision, not a fix)

- **3 duplicate serial groups** (`312023090012` XL-97/XL-99, `9cp541rlnv`
  XL-17/XL-94, `xl-98` XL-134/XL-172) — which row is right needs a physical
  check. Until they are resolved, re-running 0030 cannot create
  `assets_live_serial_unique_idx`, so there is **no** DB-level duplicate-serial
  guard and the client's friendly error for it stays dormant. `check-guards.mjs`
  reports this on every run.
- **90 of 231 assets still have no purchase price** — finance data, not code.
- `it-documents` objects remain readable by direct URL (public bucket); making
  it private requires signed URLs in `/admin`.
- No SP↔Supabase reconciliation job; outbox rows that reach `failed` are not
  retried by the 5-minute sweep (it only claims `pending`) and
  `requeue_failed_sync_rows()` does not reset `attempts`.
- `mustChangePassword()` is only consulted on the password sign-in branch, so a
  temp password still survives a magic-link arrival.
