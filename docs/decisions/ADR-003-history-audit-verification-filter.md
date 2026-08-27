# ADR-003: Audit via `asset_history` trigger + verification-only filter

## Status
Accepted — live 2026-08-26 (`0014_asset_history.sql`, `assets/index.html` `4114b1c`/`10619cd`)

## Date
2026-08-26

## Context
Every asset change must be auditable (KRA, eTIMS, internal stock-takes): who moved `Purchase Price`, who verified `Last Verified`. SharePoint `versions` API was used before (`GET /items/{id}/versions`) but required Graph, was not RLS-filtered, and verification scans drowned real edits.

Supabase migration `0014` introduced `asset_history` (`item_id, op, changed_by, fields {col:{old,new}}, old_row, new_row`) via `assets_audit_trigger` (AFTER INSERT/UPDATE/DELETE, `changed_by = coalesce(jwt.email,'service_role')`, `tracked = ["title","asset_tag","asset_type","model","serial","employee","status","location","extra"]`).

UI `History` expander (`#histPanel`) does `from("asset_history").select("op,changed_by,changed_at,fields").eq("item_id").order("id",desc).limit(50)` → `renderHistory`.

Bug 2026-08-26: `fields.extra` is a JSONB blob (`old:{purchase_date:"2025-09-01",...}, new:{...}`). Old UI did `fmtVal(v.old)+" → "+fmtVal(v.new)` where `v.old` is an object → `String({})` → `[object Object]` → `Details: [object Object] → [object Object]`. And `detail.innerHTML = html + addEventListener(...)` → `html + undefined`.

## Decision
* `diffObjectKeys(o,n)` — JSON-stringify compare per top-level extra key, collect `changed = keys where JSON.stringify(o[k])!==JSON.stringify(n[k])`.
* `VERIFICATION_KEYS = {last_verified,last_verified_by,sp_modified,sp_created}` — system fields. `meaningful = changed.filter(k=>!VERIFICATION_KEYS.has(k))`.
* If `meaningful.length===0` → verification-only: render `<b>✓ Verified</b> by {v.new.last_verified_by||changed_by}` (map `service_role→System`).
* Else → `<b>Details</b>: {meaningful.map(friendlyExtra).join(", ")}` where `friendlyExtra` maps `purchase_date→Purchase Date`, `estimate_pending→Estimate pending`, etc. (`EXTRA_FRIENDLY`).
* `changed_by==="service_role"→System` for actor column.
* `fmtVal` now `JSON.stringify` for objects (truncate 120) not `String(v)`.
* Fix stray `undefined`: terminate `detail.innerHTML='...';` not `+ document.getElementById...`.

Example — DB row 2026-08-26 13:24:03 `service_role` `extra:{old:{last_verified:null},new:{last_verified:"2026-08-26T13:23:39Z",last_verified_by:"Roystone"}}` → `System | ✓ Verified by Roystone` not `service_role | Details: [object Object]`.

## Alternatives Considered

### Keep `extra` as `String(v)` and show `[object Object]`
- Rejected: User-visible bug, CEO flagged.

### Show full `extra` JSON diff
- Pros: Complete.
- Cons: `extra` has 12+ keys (`sp_created`, `sp_modified` etc.) — noise; verification scans would list 2 system keys every time.
- Rejected: Filter verification keys.

### Store `extra` changes as per-field deltas (like other columns)
- Would need trigger to `jsonb_object_keys(extra)` diff per key → `fields.extra_purchase_date:{old,new}` separate entries. More complex migration, larger `fields`.
- Rejected: `diffObjectKeys` client-side is sufficient; trigger stays simple (`to_jsonb(OLD)->k is distinct from to_jsonb(NEW)->k` for whole `extra`).

### Hide `service_role` rows entirely
- Would hide legitimate backfill (`Purchase Price, Estimate pending` at 2026-08-25) — audit needs them.
- Rejected: Map to `System` but keep.

## Consequences
+ History is human-readable: `System | Details: Purchase Date` not `service_role | Details: purchase_date`, `✓ Verified by Roystone` not `Details: last_verified, last_verified_by`.
+ No `undefined` stray — `);` closure restored.
+ `fmtVal` for non-extra columns still `old→new` (e.g. `Status: Available → In Use`).
- Verification-only rows no longer show `last_verified` timestamp diff — intentional (timestamp is the verification itself; shown via row `changed_at`).

## Verification
* Live query `select fields from asset_history where fields ? 'extra' order by changed_at desc limit 2` → `extra:{old:{...},new:{...}}` with `last_verified` diff → UI now `✓ Verified`.
* Screenshot 2026-08-26 16:28 before: `Details: [object Object]` + `undefined`; after `4114b1c`/`10619cd`: `✓ Verified by Roystone`, `Details: Purchase Date`; after `748681c` detail `Add image` works.

## References
* `supabase/migrations/0014_asset_history.sql`, `0014b_fix_audit_trigger.sql`, `0014c_fix_audit_trigger.sql`
* `assets/index.html` `renderHistory`, `diffObjectKeys`, `EXTRA_FRIENDLY`, `VERIFICATION_KEYS`
