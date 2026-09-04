# Exec dashboard (`/dashboard`)

The executive view of the asset register: portfolio value, depreciation,
warranty exposure, verification health and breakdowns by status, type,
location and department.

Served at https://xana-assets.vercel.app/dashboard (routed here by
`vercel.json`). Two files: `index.html` and `app.js`. No build step, no
framework, no chart library. Charts are hand-rolled SVG and CSS.

## How it gets its data

Everything comes from one call, in the browser:

```
XanaSupabase.listAssetsDetailed()   →  enriched rows
XanaSupabase.computeSummary(rows)   →  every KPI on the page
```

Both live in `js/supabase-client.js`, which is also what `/assets` uses. That
is deliberate: the register and the dashboard cannot disagree about an asset's
book value, because they call the same function on the same rows.

There is no server API behind this page. An earlier design had `api/summary.js`
reading SharePoint through Microsoft Graph with a shared `?key=` in the URL,
and no per-viewer sign-in. That is retired. Access is now a Supabase session
plus the `dashboard_viewer` role (or admin), and the database enforces it.

## What it shows

- **Portfolio:** asset count, purchase value, book value, confirmed book value
  (excluding estimates), how many are fully depreciated, how many still carry
  an estimated price.
- **Depreciation:** annual charge, expensed this year, replacement due (fully
  depreciated, or inside a year of it).
- **Operations:** idle stock (available or unassigned), lost assets, assets
  unverified for over 90 days.
- **Breakdowns:** by status, type, location and department.
- **Exports:** register CSV, and a depreciation schedule with monthly charge,
  year-of-service, accumulated and closing book value per asset.

## Depreciation

Straight line, no salvage value, age prorated continuously from the purchase
date. Useful life resolves from the asset's own override, then the type's
`useful_life` in `app_choices` (editable in Admin), then a built-in map, then
3 years.

The depreciation CSV reconciles with the page: cost minus accumulated equals
the closing book value on every row. Both figures derive from the same
enrichment, which was not true before 2026-09-04.

An asset with no purchase date reads "No data", keeps its full book value and
never depreciates. It still contributes to the annual depreciation total, so a
large number of undated assets will make that figure and "expensed this year"
disagree. The fix is to date the assets, not to change the arithmetic.

## Notes

- Theme follows the shared `xana_theme` setting, same as the rest of the app.
- The page-entry overlay and all motion respect `prefers-reduced-motion`.
- Numbers are computed client side over the whole register, so the page scales
  with the size of the estate. At a few hundred assets this is instant.
