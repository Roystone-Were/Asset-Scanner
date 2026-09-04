# Xana Asset System — IT Manager Handoff / Runbook

**For:** IT Manager / whoever operates this system day to day
**Last reconciled:** 2026-09-04 (view-only role, camera batch, role-gated reads, event logging)
**Supersedes:** the referenced-but-never-committed `IT_Manager_Handoff_2026-08-26.md`
**Live:** `https://xana-assets.vercel.app` · Source of truth: Supabase `irqrnyixizzorvfmtvag` (eu-west-1)

> This is the operational runbook: what's running, where the keys are, what breaks,
> and exactly what to do about it. For narrative history read `HANDOFF.md`; for
> "why it's built this way" read `docs/decisions/ADR-001..005`.

---

## 1. Architecture in one diagram

```
Phones/desktop ──supabase-js──▶ Supabase Postgres (SOURCE OF TRUTH)
   /assets /dashboard /admin /login          │ AFTER trigger assets_to_outbox_*
   (static HTML on Vercel)                   │ → sharepoint_sync rows (pending)
                                             │ pg_net instant poke
                                             │ pg_cron 5-min retry sweep
                                             ▼
              Vercel serverless api/sharepoint-sync.js ──Graph API──▶ SharePoint list
              (drains outbox, idempotent via SupabaseId)             (READ-ONLY MIRROR)
```

- **One-way only.** Supabase → SharePoint. Never edit the SharePoint list directly; changes there are overwritten and not captured in audit history.
- **Auth:** Supabase email OTP / password, invite-only. Roles in `user_roles`: `super_admin · admin · scanner · asset_viewer · dashboard_viewer`. RLS enforces server-side; UI gating is cosmetic.
- **No offline mode.** The `localStorage` cache and write queue were retired with the move to Supabase. The app expects a connection; `localStorage` now holds only the theme and the Supabase session.

---

## 2. Routes & who can open them

| Route | File | Role required | Purpose |
|---|---|---|---|
| `/` | `index.html` | any signed-in | Chooser (role-filtered) |
| `/assets` | `assets/index.html` | asset_viewer, scanner, admin, super_admin | Register, detail, scan, people/offboarding, add |
| `/dashboard` | `summary/index.html` | dashboard_viewer, admin, super_admin | KPIs, depreciation, health |
| `/admin` | `admin/index.html` | admin, super_admin | Users, choices, sync health, documents |
| `/login` | `login/index.html` | public | Sign-in, `must_change_password` flow |
| `/scan` | `vercel.json` 308 | — | Permanent redirect to `/assets` |

API (serverless, service-role, never exposed to browser):
- `api/sharepoint-sync.js` — drains `sharepoint_sync` outbox → Graph. Triggered by `pg_net` (instant) + `pg_cron` (5-min sweep). `maxDuration 15`.
- `api/admin-users.js` — user management (list/invite/set_roles/set_active/delete/reset_password/sync_health). Re-verifies caller JWT + admin role on **every** call.

---

## 3. Database schema (Supabase)

| Table | Purpose | RLS |
|---|---|---|
| `assets` | The register. `id` uuid, `item_id` business key, `extra` jsonb | read: **any active role** (0029); write: scanner/admin; delete: admin/super_admin |
| `asset_history` | Per-change who/when/old→new, trigger-written | read: any active role (0029) |
| `asset_events` | Issues, repairs, maintenance, transfers, notes, with cost. Logged from the asset card | read: any active role; write: scanner/admin |
| `sharepoint_sync` | Sync outbox (pending/done/failed/processing) | **service-role only** (no client policies) |
| `profiles` | User profile, `active`, `must_change_password` | own row + admin |
| `user_roles` | role assignments | own + admin |
| `allowed_scanners` | legacy allowlist (superseded by roles) | — |
| `app_choices` | dropdown values (type/dept/status/location/region) plus `useful_life` per asset type | read: all auth (needed pre-role at sign-in); write: admin |
| `choice_usage` | view: how many assets use each choice value, drives the delete warning | inherits caller RLS |
| `app_config` | misc config incl. `sync_worker_key` | service-role |

Migrations live in `supabase/migrations/0001..0029`, applied via `scripts/apply-migration.mjs`.
⚠️ The DB pooler password contains `#` — **percent-encode as `%23`** in `SUPABASE_DB_URL` or clients fail silently.

---

## 4. Credentials & where they live

| Secret | Where | Notes |
|---|---|---|
| Supabase URL / publishable key | `.env.local` → `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | browser-safe (RLS protects) |
| Supabase service role key | `.env.local` → `SUPABASE_SERVICE_ROLE_KEY` + Vercel env | **NEVER in browser code** |
| Supabase DB pooler URL | `.env.local` → `SUPABASE_DB_URL` | password `#`→`%23` |
| Graph client credentials (sync worker) | Vercel env → `TENANT`, `CLIENT_ID`, `CLIENT_SECRET`, `SITE_URL`, `LIST_NAME` | client-credentials flow, `Sites.ReadWrite.All` |
| Sync worker shared key | Vercel env `SYNC_ACCESS_KEY` + DB `app_config.sync_worker_key` | authorizes pg_net/pg_cron calls |
| PnP automation cert | `C:\Users\user\Xana-SharePoint\pnp-cert.pfx` (local) + GitHub secrets | see §6 |

**GitHub Actions secrets** (repo → Settings → Secrets and variables → Actions):
`SP_TENANT`, `SP_CLIENT_ID`, `SP_CERT_B64`, `SP_THUMBPRINT`, `SP_CERT_PASS` (required — no default), optional `SMTP_*` + `MAIL_TO` for email reports.

**Golden rule:** `.env.local`, `*.pfx`, `*.cer`, `pnp-cert-pass.txt` are gitignored. Never commit them.

---

## 5. Routine operations

**Add a user:** `/admin` → Users → Invite (email) or Create with password. Assign role(s). Manual-password users are forced to change at first sign-in.

**Offboard an employee:** `/assets` → People → search name → **Mark all returned**. Sets Status→Available, clears Employee, logs a transfer event.

**Add/change a dropdown value:** `/admin` → Lists. Categories are collapsible; each value shows how many assets use it, and removing one asks for confirmation first. Asset types also carry a **useful life in years** here, which drives depreciation, so a new type can be added and costed without a code change. Do not edit the SharePoint choice columns; they were converted to plain text so values mirror freely.

**See sync health:** `/admin` → Sync health, or SQL:
```sql
select status, count(*) from sharepoint_sync group by status;
-- pending/failed should be 0 in steady state
```

**Re-export asset snapshot (for tests/labels):**
```powershell
pwsh -NoProfile -File Export-AssetsJson.ps1   # → scanner-app/test/fixtures/assets.json
```

**Deploy:** `git push origin main`. Vercel's Git integration builds and promotes automatically; there is no CLI step. Verify by curling a live file for something only the new build contains.

**Revoke access:** `/admin` → Users → untick Active. Since 0029 this removes the account's read access to assets, history and events, not just the screens. Reactivating restores it immediately.

---

## 6. Certificate rotation (PnP / SharePoint automation)

The data-health workflow + local PS scripts authenticate with a **self-signed client certificate** on the Entra app `pnp` (`7caa51af-9f32-42d8-8264-da5b97c2f8eb`). The pfx password is **random per generation** — there is no default.

Rotate (expiry, or suspected compromise):
```powershell
powershell -NoProfile -File C:\Users\user\Asset-Scanner\generate-cert.ps1
```
It creates a new cert (random password → `pnp-cert-pass.txt`), prints the thumbprint, then:
1. Upload `pnp-cert.cer` → Entra → app `pnp` → Certificates & secrets → **Certificates** → Upload.
2. Update GitHub secrets: `SP_CERT_B64` (base64 of pfx), `SP_CERT_PASS` (contents of `pnp-cert-pass.txt`), `SP_THUMBPRINT` (new thumbprint).
3. Actions → data-health → **Run workflow** → confirm green.
4. Delete the **old** cert from Entra. Delete `pnp-cert-pass.txt`.
5. Update the `-Thumbprint` default in the PS scripts + references in `HANDOFF.md`/`README.md`.

Base64 for the secret:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\user\Xana-SharePoint\pnp-cert.pfx")) | Set-Clipboard
```

---

## 7. Automated monitoring

- **`.github/workflows/test.yml`** — runs `node --test` on `scanner-app` (44 tests) + syntax-checks both API functions on every push/PR. Hardening: make `test` a **required status check** on `main`.
- **`.github/workflows/data-health.yml`** — monthly (1st, 06:00 UTC): duplicate serials, missing tags/serials, missing/renamed columns, assets unverified 90+ days, cert expiry <90 days. Files a GitHub issue (@owner) on issues; commits `health-history.json` for month-over-month deltas. GitHub disables scheduled workflows after 60 days of repo inactivity — re-enable via Actions if it goes quiet.

---

## 8. Troubleshooting (the stuff that actually breaks)

| Symptom | Likely cause | Fix |
|---|---|---|
| App stuck on spinner | cold-start auth race / stale cache | hard reload (Ctrl+Shift+R); clear site data |
| Workflow fails: "SP_CERT_PASS secret is not set" | cert rotated but secret not added | set `SP_CERT_PASS` (§6) |
| Workflow fails `AADSTS700027` / cert not found | secrets point at deleted/old cert | re-upload `.cer` to Entra, sync `SP_THUMBPRINT`+`SP_CERT_B64` (§6) |
| `sharepoint_sync` pending > 0 for minutes | Graph throttle / sync worker down | check `/admin` sync health; `pg_cron` sweep drains within 5 min; check Vercel fn logs |
| Duplicate SP row after network blip | lost response | worker adopts orphan by `SupabaseId` — should self-heal; if not, delete the SP duplicate |
| DB client can't connect | `#` in password not encoded | percent-encode as `%23` |
| Health report: "Missing column: Asset Tag" | someone renamed Title in SP UI | restore internal name; SP is read-only mirror |
| Scan opens the wrong asset | a code exists as one asset's tag and another's serial | expected to resolve to the **tag**; if not, check `findAssetByCode` in `scanner-app/logic.js` |
| User sees an empty register | account has no active role, or was deactivated | `/admin` → Users: tick Active and assign a role |

---

## 9. Backup & recovery (read this before you need it)

- **Source of truth = Supabase Postgres.** Free tier: enable/verify **Point-in-Time Recovery** or schedule logical dumps (`pg_dump` via pooler) — confirm current backup posture on the Supabase dashboard; free tier has limited retention.
- **SharePoint mirror is NOT a backup** — it's field-mapped (subset of columns), so it can't fully reconstruct `assets`/`extra`.
- **Recovery drill (do once, document):** create a throwaway Supabase project → apply migrations `0001..0029` in order → restore a `pg_dump` → verify row counts. Time it. That's your RTO.
- **RPO** depends on backup schedule; if using only Supabase free-tier daily backups, RPO ≈ 24h.

---

## 10. On-call quick facts

- Live URL: `https://xana-assets.vercel.app`
- Support/admin: `it@xanalife.com` (admin), `roystone@xanalife.com` (super_admin)
- Supabase project: `irqrnyixizzorvfmtvag`, region eu-west-1
- SP list id: `7d3b5f47-8199-4cb9-b7c4-361dc70c4622`, site `xanalifeTechData`
- GitHub repo: `Roystone-Were/Asset-Scanner` (push to `main` = deploy)

---

*Reconciled 2026-09-04 against repo state: migrations 0001-0029, api/sharepoint-sync.js, api/admin-users.js, .github/workflows/. Update this file when infra changes.*
