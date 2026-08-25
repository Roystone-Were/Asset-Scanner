# Session notes — Aug 25, 2026 (premium pass → events → recycle bin → landing/login)

Continues `session-aug24-2026.md`. Read both; where they conflict, THIS file wins
(its stale lines are annotated below).

## Landing + login combined — USER DECISION (late session)
Sign-in now lives ON the landing page (`index.html`): signed-out visitors get the
hero left + sign-in card right; signing in dissolves the card and reveals workspace
tiles in place. `/login/index.html` is a smart redirect: forwards to home,
preserving `?next=` intent for post-auth routing. All auth flows preserved on the
landing page script: OTP magic link, password tab, forced password change,
no-access messaging. Footer tech notes ("Supabase is the source of truth ·
mirrored live to SharePoint") REMOVED per user — internal plumbing doesn't belong
on public-facing pages.

## Landing boot-stuck bug (self-inflicted, caught by user)
The redesigned landing's signed-out branch queried a `.signin-mini` element that
was never added to the markup → script threw BEFORE hiding the boot veil →
signed-out users stared at "Checking your session…" forever. Signed-in testing
missed it because that branch only runs signed-out.
LESSON: when a redesign adds JS-referenced elements, verify every
getElementById/querySelector target exists in the new markup, and test BOTH
auth states (incognito = signed-out path).

## Image-upload removal misread — USER CORRECTION
User said "remove 'Add via the form supports image upload.'" meaning the
SUBTITLE SENTENCE only; assistant deleted the entire upload feature (dropzone +
handler + save-path upload). User: "i did not say you drop image upload, if you
removed please revert" → fully restored. LESSON: when asked to remove text,
remove exactly that text; confirm scope before deleting working features.

## Em-dash placeholder prefill bug
Clicking an empty ("—") field prefilled the editor with the dash as TEXT — saving
wrote "—" as a real value. Fix: `hasValue = orig && orig !== "—"`; editors open
empty with `placeholder="add <field>"`; dropdowns select "— none —". Never let a
display placeholder leak into an editor's value.

## Delete = soft delete / recycle bin (migration 0019) — USER DECISION
Hard DELETE is gone from the UI flow. `deleteAsset()` sets `deleted_at` via a
`_softDelete` pseudo-key in fieldsToRow; the UPDATE still fires mirror + audit
triggers. `restoreAsset()` clears it, `purgeAsset()` hard-deletes (confirm dialog).
listAssets/listAssetsDetailed filter `deleted_at is null`; `listDeletedAssets()`
feeds Admin → Recycle Bin tab (restore/purge per row). Rationale: recoverability;
"Retired" status remains the accounting path for real disposals — delete is for
test data/mistakes only.

## Serial "0000" placeholder convention — USER DECISION
User types serial "0000" to mean "serial added later". enrichAsset() normalizes
it to "" so dup-serial checks, deep-links and health stats ignore it. Don't "fix"
0000 rows as errors; when the real serial arrives he edits the field normally.

## Duplicate-tag incident (root cause class: identity-by-non-unique-key)
Clones saved with their source's tag → duplicate tags → row click used
`allItems.find(x=>x.tag===clickedTag)` which always returned the FIRST match, so
clicking row B opened row A's details ("XL-96 shows different device in list vs
detail"). Fixes: rows carry `data-idx` into the filtered array (never look up rows
by tag/serial); deep-links match numeric id first; add form blocks duplicate tags
case-insensitively; Clone pre-fills the next free XL-<n> tag (computed from
allItems, pre-selected for one-keystroke overwrite). LESSON: any lookup keyed on a
user-editable non-unique field will cross-wire eventually. Index-address DOM rows;
validate uniqueness at save.

## Shared navbar — css/nav.css (single source)
All three app pages' inline navbar CSS was DELETED; `css/nav.css` owns it now:
floating glass pill detached 14px from top edge, blur + hairline + ambient shadow,
active link = accent-tint fill + accent text (old faint gray outline invisible on
dark), round theme toggle with hover rotation, mobile menu drops as a floating
card below the pill. CAUTION: after moving styles out, grep each page for leftover
conflicting rules — dashboard kept a stale mobile media query that fought nav.css
and broke its layout at some widths ("what happened here" screenshot). When
centralizing styles, delete ALL per-page copies including media queries.

## All-fields inline editing
Detail card editrows now cover SerialNumber/Model/Department/Employee/Location/
Status/Condition/Asset/PurchaseDate/PurchasePrice. Type uses _choices.type
(loaded from app_choices asset_type in getChoices()); date uses type=date; price
strips KES formatting, coerces numeric, empty clears to null. Book Value /
Dep Status / Useful Life stay read-only (computed).

## Supabase gotchas (new this session)
- Auth admin DELETE requires PATH segment: `/auth/v1/admin/users/<uuid>` —
  the query-param form (`?id=`) returns 405. Reproduce-create-delete against prod
  before shipping admin API changes.
- supabase-js v2 method names: `.in(col, arr)`, NOT v1's `.in_()` — Sync health
  tab shipped broken until first clicked. Grep for v1 names in query chains.
- assets.item_id is a separate NOT NULL column from the uuid PK — bulk inserts
  must call next_asset_item_id() RPC and set item_id explicitly.
- Recycle-bin migration 0019 added assets.deleted_at + partial index.

## Browser-native dialogs are banned in this app
confirm()/alert()/prompt() replaced by in-page showDialog/showDeleteDialog +
toast patterns (admin has the full set; /assets has delete dialog + toast).
Danger buttons = solid #dc2626 white text — soft pink ghost style failed
legibility (~3:1 contrast); user flagged it directly.
Row-action buttons use .small pills (.7rem/500 weight), NOT full-width flex:1 —
user flagged the stretched invite button as "a huge button".

## Motion & scrolling lessons
- Donut fill-up: stroke-dashoffset draw-in does NOT work on filled wedge paths
  (only traces an invisible outline). Radial scale + slight rotate from center
  (`transform-origin: 90px 90px`) reads as "filling up". Reduced-motion static.
- Global `scrollbar-width:none` made scrolling feel abrupt and hid affordance.
  css/base.css provides thin overlay scrollbars, root smooth-behavior, and
  overscroll-behavior:contain on .tbl-scroll/.fpop/.sheet-panel so inner
  scrollers don't chain to page scroll.
- Dashboard .tbl-scroll must match /assets behavior: smooth + contain + rounded
  panel background. Keep inner-scroller styling identical across pages.

## Premium surface system — completion state
Dashboard, /assets, AND /admin all migrated (admin: surface tokens, accent-border
tabs, 2-col .lists-grid, boot veil). Inter self-hosted app-wide via css/base.css
(@font-face + tnum figures on tables/KPIs). Unified color semantics: green =
primary action, teal #0d9488 = money/book-value actions, neutral secondary,
red only for destructive/status. Status palette desaturated to Tailwind-600
weights; chart triad teal/blue/violet. Only scanner-app retains old styling.

## Bulk operations pattern
User drives data entry in batches: "clone 5 cash drawers Syokimau", "4 Ruiru",
"set every scanner 33,500 KES", "cash drawers 14,500", bulk asset-type price
updates by type filter. Service-role PATCH with spread-existing-extra + new keys;
VERIFY counts back ("12/12 updated", re-query after) and check the mirror outbox
shows done. Copy a sibling asset's extra as template; set item_id from
next_asset_item_id() RPC. Region conventions: Ruiru→Kiambu, Syokimau/Githurai→
Nairobi.

## Vercel deploy quota (HIT this session)
Free tier caps ~100 deploys/day; error `api-deployments-free-per-day`. Push to
GitHub still triggers CI later. Transient vercel CLI `fetch failed` — sleep and
retry worked. Batch deploys instead of per-commit.

## Stale-notes discipline
aug24 notes said "/scan and /admin pending" for FOUC/premium — /admin got both
this session. Update stale status lines when closed rather than leaving
contradictory guidance. Still pending: /scan premium + boot veil.

## Asset-delete plan exists but superseded
`.hermes/plans/2026-08-25_084016-asset-delete.md` described hard delete; shipped
implementation is soft delete (see top). Read the plan for verification-matrix
structure only.
