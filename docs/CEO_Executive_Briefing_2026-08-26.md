# Xana Asset System — Executive Briefing

**For:** CEO  
**From:** IT / Asset Systems  
**Date:** 2026-08-26  
**Version:** Live on `xana-assets.vercel.app`  
**Classification:** Internal

> One page: where we are, what it costs, what changed today, what you need to decide.

> **Superseded by `docs/Exec_Briefing_2026-09-04.md`.** Kept as the record of
> what was reported on 26 August 2026. Its figures and the offline-resilience
> claim no longer describe the system.

---

## 1. One-paragraph summary

The Xana Asset System is now the single source of truth for all company assets. Staff scan a barcode or type a tag/serial in `/assets` and the register updates instantly; the SharePoint list your teams already use is a **read-only mirror** kept in sync automatically. The executive **Dashboard** (`/dashboard`) shows live portfolio value, depreciation, and health from the same data. The system replaces manual SharePoint edits and fragmented spreadsheets with audited, role-controlled, offline-capable software.

---

## 2. Portfolio snapshot — live from Supabase (2026-08-26)

| KPI | Value |
|-----|-------|
| **Live assets** | **144** (0 deleted) |
| **Deployed (In Use)** | 142 (98.6%) · Available 2 |
| **Top locations** | Syokimau 64 · Ruiru 55 · TRM 5 · Lumumba 4 · Katani 4 |
| **Top types** | Printer 19 · CPU 16 · Monitor 15 · Scanner 12 · Mouse 12 · Keyboard 12 |
| **Purchase value captured** | **KES 2,177,420** (63 assets with invoice value) |
| **Estimate pending** | 100 assets — invoices being collected (Finance) |
| **Unverified >90 days** | **19 assets** — need a floor check |
| **Assets with photo** | 0 — new feature live today, backfill in progress |
| **Sync health** | 781 SharePoint mirrors `done`, **0 pending/failed** — pipeline healthy |

**Depreciation:** Straight-line by type (Laptop 3y, Desktop/Tower/CPU 4y, Monitor 5y, etc.). Dashboard computes **book value** and **replacement due** (fully depreciated or <12 months remaining) client-side — no extra service cost.

---

## 3. What changed — 26 Aug 2026 issues resolved

| Issue you saw | What it was | Fix deployed |
|---------------|-------------|--------------|
| **Page stuck on black spinner** (`xana-assets.vercel.app`) | Cold-start auth race + Vercel cache | Auth hash sanitiser + cache-buster; hard-reload resolves |
| **History showed `Details: [object Object] → [object Object]`** | Audit trigger stores `extra` as JSON blob; old UI stringified the whole object | Now diffs the blob and lists only changed fields: `Purchase Date`, `Department`… verification-only edits show `✓ Verified by Roystone` |
| **`undefined` text below history card** | `detail.innerHTML = html + addEventListener(...)` — `addEventListener` returns `undefined`, concatenated into HTML | Terminated string with `;` — `undefined` removed |
| **`purchase_price`, `purchase_date` snake_case** | Raw JSON keys shown verbatim | Mapped to `Purchase Price`, `Purchase Date` via `EXTRA_FRIENDLY` |
| **`service_role` as actor** | System writes showed internal `service_role` | Now `System` in UI; verifier name shown (`by Roystone`) |
| **No photos visible** | `0` assets had `image_url` — feature existed but no UI to add to *existing* assets, and add-sheet errors were silent | Added **Add image / Change image** button on every detail card (scanner/admin only) + toast on failure; bucket `asset-images` public-read, scanner-gated writes. Add-sheet `Click to upload image` now persists via `asset_extra_merge` |

All 4 commits pushed to `main` — Vercel auto-deployed. Verify with hard-reload.

---

## 4. Business impact

* **Audit readiness:** Every change writes `asset_history` (`who, when, {old→new}`) — KRA/eTIMS hardware trail without manual logs. `✓ Verified` scans give a check-in proof per asset.
* **Offboarding:** People view → search employee → **Mark all returned** (142 In Use → 2 Available path tested) — 1 tap, queued offline if on floor.
* **Offline resilience:** Last fetch cached in `localStorage`; writes queue (50 cap) and flush on `online` — floor staff in Syokimau/Ruiru don't lose scans.
* **SharePoint as mirror, not master:** Supabase is master; `sharepoint_sync` outbox + `pg_net` immediate poke + `pg_cron` every 5 min + Vercel worker `api/sharepoint-sync.js` mirrors to SharePoint with idempotency (`SupabaseId`). SharePoint can be read-only locked without data loss.
* **Photos:** Visual verification for high-value assets (POS, printers, CPUs) — reduces mis-identification and speeds stock-takes.

---

## 5. Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| 100 assets `estimate_pending` — book value understated | High | Finance to attach invoices; `Purchase Price` field is required or `estimate pending` must be ticked — enforced in UI and DB (`0013_asset_quality_constraints`) |
| 19 assets unverified >90 days | Medium | Monthly `Health-Check.ps1` → GitHub issue + optional email; floor walk mode (`W` hotkey) does checkout-counter continuous scan |
| Old Vercel deployments still serve `assets.csv` at immutable URLs | Medium | `.vercelignore` now blocks snapshots; **action:** delete old deployments in Vercel Dashboard → Deployments → … → Delete |
| Custom SMTP not configured — magic-link emails are code-style and sender is noreply@supabase | Low | Awaiting mailbox password for `SMTP_PASS` → `smtp.office365.com:587` — then branded emails |
| Single `SUPABASE_DB_URL` password contains `#` — mis-configured clients fail | Low | Always percent-encode (`%23`); documented in `PROGRESS.md` |

---

## 6. Costs (current)

* **Supabase** (eu-west-1, project `irqrnyixizzorvfmtvag`): Free tier + pooler — no egress surprise (all reads via `getSession` + RLS).
* **Vercel** (`xana-assets.vercel.app`): Hobby — `api/sharepoint-sync.js` is a serverless function, <1s per outbox drain.
* **Storage** (`asset-images`): Public bucket — a 400 KB photo × 144 assets ≈ 58 MB — within free limits.

No new licenses.

---

## 7. What needs a decision

1. **Custom SMTP password** — provide `SMTP_PASS` for `noreply@` mailbox → I wire `smtp.office365.com:587` and switch templates to branded HTML (free-tier template editing is locked until custom SMTP exists). *Owner: IT Manager + CEO approval for mailbox.*
2. **Photo backfill policy** — approve floor team photographing all 144 assets (est. 2–3 days, Ruiru + Syokimau) — IT to run.
3. **Estimate pending deadline** — Finance to clear 100 pending invoices by **30 Sept 2026** for accurate year-end book value.
4. **Unverified sweep** — schedule 19-asset floor verification sprint this week.

---

## 8. How to use (CEO)

* **Dashboard:** `xana-assets.vercel.app/dashboard` → KPIs, fully-depreciated list, idle stock, lost assets.
* **Register:** `/assets` → search, tap row for detail, History, Log event, Add image.
* **Admin:** `/admin` (admin/super_admin only) → invite staff, set roles, manage dropdowns (Type/Department/Status/Location), view Sync health.

---

## Appendix — Where to read more

* **IT Handoff:** `docs/IT_Manager_Handoff.md` — architecture, runbooks, credentials, RLS, sync pipeline, troubleshooting.
* **Live docs:** `README.md` (quick start), `HANDOFF.md` (full history), `PROGRESS.md` (migration log), `docs/decisions/ADR-*.md`.
* **Support:** `it@xanalife.com` (admin), `roystone@xanalife.com` (super_admin) — both have all roles.

*Generated 2026-08-26 from live Supabase counts and Vercel deployment `asset-system-tau`.*
