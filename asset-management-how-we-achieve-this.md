# Asset Management Requirements — How We Achieve Each

Answers mapped to the existing Xana build (Supabase + Vercel apps + SharePoint mirror), with effort markers:

- **[BUILT]** — already works today, or a small config change
- **[SMALL]** — hours-to-a-day of build on Xana
- **[MEDIUM]** — a focused feature (days), still inside Xana
- **[EXTERNAL]** — needs another tool/integration, or is genuinely separate work

Guiding principle: Xana is the primary system. SharePoint stays a mirror. Nothing new gets bought.

---

## 1. Lifecycle Tracking

| Need | Answer | Status |
|---|---|---|
| Purchase date & cost at procurement | Already captured (`purchase_date`, `purchase_price` in extra). Gap is discipline, not tech — see §10 validation. | [BUILT] |
| Warranty period & expiry alerts | Add `warranty_months` + `purchase_date` → expiry computed; dashboard widget "expiring ≤30/60/90d" reuses the depreciation-date pattern that exists today. | [SMALL] |
| Deployment date & branch | `location` column covers branch today. Add `deployed_at` date on the asset form. | [SMALL] |
| Maintenance / repair history | New `asset_events` table (asset_id, type=maintenance/repair/transfer/note, date, cost, notes, by). One table powers §1, §2 transfers, and IT "open maintenance" widgets. | [MEDIUM] |
| Depreciation schedule | Already computed client-side per asset (straight-line, useful-life-by-type). Add the method/rate as visible fields so Finance can audit the math. | [SMALL] |
| Retirement & disposal record | Status "Retired" exists. Extend with `disposal_method`, `disposal_date`, `disposal_value` shown when status = Retired. | [SMALL] |
| End-of-life forecasting | Dashboard already flags replacement-due via useful-life math. Refine: flag at 80%/90%/100% of useful life with dates, not just a count. | [SMALL] |

**Sequencing:** `asset_events` table first — three requirements hang off it.

---

## 2. Location and Branch Granularity

| Need | Answer | Status |
|---|---|---|
| Branch-level assignment | Locations are already admin-managed dropdown values (app_choices). Formalize naming: branch = first token. No schema change needed. | [BUILT] |
| Sub-location detail | Add free-text `sub_location` (room/cabinet/shelf) next to Location. | [SMALL] |
| Assigned user / department | Both fields exist. Department becomes enum-locked in §10 cleanup. | [BUILT] |
| Transfer history | Falls out of `asset_events` (type=transfer, from→to) — auto-write an event whenever Location or Employee changes. | [MEDIUM] |
| Physical audit workflow | **This is the scanner app you already have.** Walk mode = spot-check audit; every scan stamps Last Verified. Add an "Audit mode" toggle that filters to one branch and exports pass/fail. The 85 unverified assets get cleared by one walk afternoon per quarter. | [SMALL] |

---

## 3. Software and License Tracking

Licenses aren't physical assets — don't force them into the register. Two options:

- **Option A (recommended):** new `licenses` table in Supabase (name, vendor, seats, renewal_date, cost_per_seat, notes) + simple Admin tab. M365 seats pull from Graph API later.
- **Option B:** model licenses as assets with type=License. Faster but pollutes financial reporting.

| Need | Answer | Status |
|---|---|---|
| M365 license allocation | Option A table, then Entra ID Graph read (you have the tenant app registration already) to count actual assigned licenses vs purchased. | [MEDIUM] |
| Business Central seats | Manual entry in same table. | [SMALL] |
| POS / eTIMS software licenses | Manual entry, tagged to device item_id where applicable. | [SMALL] |
| Renewal dates & cost | Columns in the table; dashboard widget lists renewals next 90d. | [SMALL] |
| Over/under-licensing | Purchased vs assigned counts per product — a comparison query once allocation data exists. Usage telemetry beyond assignment is out of scope for now. | [MEDIUM] |

---

## 4. Automated Discovery and Reconciliation

This is the one section where honesty matters: real network discovery is a project, not a feature.

| Need | Answer | Status |
|---|---|---|
| Network scan for unregistered devices | Run **Nmap/pi-hole style scan on a schedule** from any always-on machine at each branch (or a cheap Raspberry Pi per site): ping sweep + MAC/hostname collection → CSV → import script compares against register. Zero licence cost. | [EXTERNAL]+[SMALL] glue |
| Flag assets not checked in X days | Last Verified already tracks this; dashboard already reports 85 unverified 90d+. Add a filterable list page for IT. | [BUILT]+[SMALL] |
| Auto-populate device details | Discovery CSV import maps hostname/IP/MAC/OS into asset extra fields where serials match; unmatched devices become "unregistered device" candidates. | [SMALL] glue script |
| MikroTik / D-Link / UniFi integration | UniFi has a proper API — a small script can pull known clients/APs. D-Link switches: SNMP if enabled. MikroTik: RouterOS API. Realistically: pick UniFi first (API is trivial), treat D-Link/MikroTik as manual until it hurts. | [EXTERNAL] phased |
| Scheduled reconciliation report | GitHub Actions cron (already runs data-health monthly) runs the diff script and files an issue: registered-but-absent, present-but-unregistered. | [SMALL] |

---

## 5. Financial and Depreciation Reporting

| Need | Answer | Status |
|---|---|---|
| Book value over time | Compute-on-read today; §9's scheduled precompute will snapshot month-end book values into a summary table → real trend lines. | [MEDIUM] |
| Accounting-period depreciation reports | Straight-line annual figure exists per asset. Add monthly view (annual ÷ 12, pro-rated from purchase date) grouped by asset class, exported as CSV — that's what James actually imports. | [SMALL] |
| Total cost of ownership | Purchase price + sum of maintenance events (needs §1 `asset_events`) + support contract costs (§6). | [MEDIUM] after §1 |
| Replacement budget forecast | Dashboard already computes replacement-due. Upgrade: list replacements due in next 6/12 months *with estimated cost* (current avg price per type). | [SMALL] |
| Business Central-compatible export | CSV export with configurable column mapping (BC's journal import template). Confirm exact BC import spec with James before building — likely just fixed headers + date format. | [SMALL] |

---

## 6. Vendor and Warranty Management

Same shape as licenses: one small `vendors` table (name, contact, phone, email, SLA notes), linked from assets by vendor name.

| Need | Answer | Status |
|---|---|---|
| Vendor linkage | Dropdown on asset form sourced from vendors table (Liquid, Simokai, etc.). Free-text stays allowed initially to avoid blocking data entry. | [SMALL] |
| Warranty expiry alerts | Covered in §1. | [SMALL] |
| Support contracts & renewals | Columns on vendors table or per-asset support_contract fields; renewal widget shared with licenses. | [SMALL] |
| SLA reference | Text field on vendor record. | [SMALL] |
| PO / invoice reference | Free-text `po_reference` on asset + file attachment (Supabase Storage bucket already exists for images — reuse for PDFs/photos of invoices). | [SMALL] |

---

## 7. Compliance and Audit Trail

| Need | Answer | Status |
|---|---|---|
| Full change history per asset | Two layers already exist: `asset_events` (§1) captures business changes going forward; SharePoint version history retains the mirror's history. For strict DB-level audit, add a Postgres trigger writing old/new row JSON to an `audit_log` table — cheap and complete. | [MEDIUM] |
| Access logs for sensitive categories | Tag sensitive assets (Matrix COSEC, POS/eTIMS hardware) with a `sensitive` flag; every scan/view of a flagged asset writes an event. Note honestly: this logs *register* access, not physical device access — Matrix COSEC has its own logs. | [MEDIUM] |
| Audit-ready KRA/eTIMS export | Filtered export (flagged assets only) with purchase/warranty/disposal columns as CSV/PDF. | [SMALL] |
| Data Protection Act alignment | Assets holding personal data (CCTV/NVR, POS) get the same flag + a data-battery note. Actual DPA compliance is a policy exercise, not software — keep a register of what personal data each asset processes. | [SMALL] flagging only |
| Retention after disposal | Disposed rows stay in Supabase (status=Retired/Disposed); SharePoint mirror keeps them too. Document a 7-year retention note. Effectively [BUILT] once disposal fields exist. | [BUILT]+policy |

---

## 8. Integration with Existing Systems

| Need | Answer | Status |
|---|---|---|
| Power Apps register sync | **Already done, inverted.** Supabase is now source of truth; SharePoint list mirrors automatically (~5s, verified end-to-end). Power Apps views can read the same list read-only. Don't sync back. | [BUILT] |
| Entra ID user-to-asset assignment | Read-only Graph integration (tenant app registration exists): pull active user list into a picker on the Employee field instead of free text. Kills misspellings and gives clean offboarding (the People view already handles leavers). | [MEDIUM] |
| UniFi Protect camera inventory | Script pulls camera list from Protect API → upserts as assets with type=Camera. One-way, nightly. | [SMALL] if NVR is UniFi |
| Business Central integration | Start with CSV export (§5). Direct API write-in is only worth it if James asks for automated journals — that's a BC-side project with their implementer. | [SMALL] now, [EXTERNAL] later |
| Single source of truth decision | **Decided: Xana (Supabase) is primary.** SharePoint is a mirror for Power Apps/report compatibility. This was settled during the migration and should be stated in one line of docs so nobody re-litigates it. | [BUILT] |

---

## 9. Reporting and Dashboards

Decision recorded: built into the app, no Power BI. Correct call at this scale.

| Need | Answer | Status |
|---|---|---|
| CEO risk rollup (RAG per branch) | Risk score per branch from: unverified %, lost/stolen count, overdue maintenance (§1), warranty-expired critical assets. Computed nightly, rendered red/amber/green tiles. | [MEDIUM] after §1 |
| Value trend | Month-end snapshots (see §5). | [MEDIUM] |
| Downtime cost tied to failures | Needs maintenance events with downtime_hours + estimated cost/hour. Directionally useful even with rough estimates. | [MEDIUM] after §1 |
| Upcoming replacements by branch | §5 forecast, grouped by location — trivial grouping once forecast exists. | [SMALL] |
| Finance depreciation curve | Monthly depreciation series per class (§5). Chart is SVG/CSS like existing ones. | [SMALL] after §5 |
| License spend vs utilization | §3 comparison. | [MEDIUM] |
| Cost per branch | Group purchase/book value by location — mostly [BUILT] (by-location exists). | [SMALL] |
| IT widgets: overdue maintenance, expiries 30/60/90, reconciliation status | All fall out of `asset_events` + warranty fields + §4 diff. | [MEDIUM] |
| Branch breakdown everywhere | Existing by-location view generalizes; ensure every new widget groups by branch. | [BUILT] pattern |
| Role-based views | RBAC roles already exist (admin/scanner/viewers). Map: CEO → dashboard_viewer sees exec widgets; James → finance widgets; Roystone/Damond → IT+everything. Same shell, widgets filtered by role claims. | [SMALL] |
| Precomputed aggregations | pg_cron already runs in Supabase (sync retry sweep). Add a nightly materialized-summary refresh; dashboards read precomputed tables. Removes page-load math entirely. | [MEDIUM] |

---

## 10. Data Quality and Validation

The 112-asset numbers (109 missing tag, 110 missing price) are the most urgent item in this whole document — they make every financial number unreliable.

| Need | Answer | Status |
|---|---|---|
| Required Tag & Serial at creation | Form-level required checks (trivial) + DB CHECK constraint as backstop. Existing blank-tag rows get a one-time backfill session before enforcement. | [SMALL] |
| Department locked to dropdown | Move department into app_choices; migrate existing variants ("Operartions", "Finace And Admin") with one SQL mapping pass. Form becomes select-only. | [SMALL] |
| Price required OR "estimate pending" flag | Checkbox `estimate_pending`; dashboard shows estimate-pending assets separately and excludes them from confident book-value totals rather than reading KES 0. | [SMALL] |
| 90-day verification workflow | Scanner walk mode IS the workflow. Add: monthly digest email (GitHub Actions cron exists) listing top unverified branches + an aging chart on IT view. | [SMALL] |
| Label clarity ("BO" column etc.) | Rename headers to plain language ("Book value (KES)") — pure copy pass. | [SMALL] |
| Health % target + owner | Set target (e.g. ≥95% within 60 days), owner = Roystone, tracked on dashboard as trend vs target line. Config change + one line of copy. | [SMALL] |

**Suggested first sprint:** all of §10. It converts the dashboard from "directional" to "numbers Finance can sign off."

---

## 11. Practical / Operational Considerations

| Need | Answer | Status |
|---|---|---|
| Barcode/QR labeling | Staff already scan vendor barcodes (works today). For unlabeled assets: cheap DYMO/LabelWriter thermal printer + QR encoding the asset tag; scanner reads QR via camera mode. ~KES 8–15k one-off, no subscription. | [BUILT] scanning / [SMALL] printing |
| Mobile-friendly issue reporting | Apps are already mobile-first PWA-style. Add a lightweight "Report problem" action on any asset (writes an asset_event, shows in IT view). | [SMALL] after §1 |
| Low-cost tooling | Current stack: Vercel hobby + Supabase free tier + GitHub Actions = KES 0/month at current scale. Watch Supabase limits (DB size fine; check bandwidth if images grow). Everything proposed above fits free tiers except possibly custom domain/email. | [BUILT] |
| Minimal admin overhead | Deliberate design constraint: prefer cron scripts + GitHub Actions (already set up) over new servers. Every [EXTERNAL] above chosen to be set-and-forget. | [BUILT] |
| Migration path without data loss | Done — 111 items backfilled idempotently, counts verified, SharePoint kept as fallback mirror. | [BUILT] |
| Scalability for new branches | Adding a branch = adding location values in Admin. Nothing else changes. Supabase scales well past any realistic asset count here. | [BUILT] |

---

## Recommended order

1. **§10 data quality** — everything downstream inherits clean data
2. **§1 lifecycle core** (`asset_events` + warranty/disposal fields) — unlocks §2 transfers, §6 TCO, §9 IT/CEO widgets
3. **§2 audit workflow** — uses existing scanner, clears the 85-unverified backlog
4. **§5 finance exports** — makes James self-sufficient
5. **§3+§6 licenses/vendors** — one Admin tab each
6. **§4 discovery** — pilot one branch with a Pi + nmap before committing
7. **§7 audit trail** — add the trigger once event patterns settle
