# Xana Asset Summary — C-suite Dashboard (Route A)

A real-time executive summary of the **Xana Asset Inventory**, designed to be
**embedded on the existing SharePoint site** via the Embed web part. No Power BI,
no build step, no per-viewer login.

- Live data on every open (serverless backend reads SharePoint via Microsoft Graph
  as the app itself — viewers need no sign-in).
- Straight-line depreciation computed per asset (useful-life defaults by type).
- Access-protected via a shared key (`?key=...`), since the data contains employee
  names/serials.

> **beUI (starc007/ui-components) was evaluated and NOT used:** it's a React 19 /
> Next.js / Tailwind motion-component library that requires a full build pipeline.
> Route A is intentionally a no-build, self-contained page — so charts are
> hand-rolled SVG/CSS instead. If a beUI look is required later, pivot this
> project to Next.js (documented under *Future*).

## Architecture

```
┌─────────────┐   Embed web part (iframe)   ┌──────────────────────────┐
│ SharePoint  │◄────────────────────────────│  summary/index.html      │
│ site page   │      https://….vercel.app    │  (self-contained, static)│
└─────────────┘                             └───────────┬──────────────┘
                                                        │ GET /api/summary?key=…
┌────────────────────────────────────────────────────────▼──────────────────┐
│  Vercel serverless function  (api/summary.js)                              │
│  · MSAL client-credentials (app-only) → Graph token                        │
│  · resolves site + list, fetches all items (paged)                         │
│  · computes KPIs / status / type / location / depreciation / data health   │
│  · returns JSON (no-store)                                                 │
└───────────────────────────────────────────────┬────────────────────────────┘
                                                │ app-only Graph (Sites.ReadWrite.All Application)
                                        ┌───────▼────────┐
                                        │ SharePoint List │  ← single source of truth
                                        └────────────────┘
```

## File structure

```
summary/
  index.html          # Self-contained dashboard (KPIs, donut, bars, register table)
  api/summary.js      # Serverless backend: Graph fetch + summary computation
  package.json        # @azure/msal-node (the only dependency)
  vercel.json         # Vercel function config
  .env.example        # Documented environment variables
  .gitignore          # Keeps .env.local / secrets out of git
  test/summary.test.js# Unit tests for the summary computation
```

## API endpoints

| Endpoint | Method | Auth | Returns |
|---|---|---|---|
| `/api/summary` | GET | `?key=` or `x-summary-key` header | `{ totals, byStatus, byType, byLocation, byDepartment, dataHealth, items[] }` |
| `/` | GET | — | The dashboard page |

Key payload fields:
`totals.{total,purchaseValue,bookValue,fullyDepreciated,expensedThisYear,missingPurchase}`
· `dataHealth.{missingTag,missingSerial,missingPurchase,unverified}` · `items[]` (one row per asset).

## Depreciation model (straight-line, C-suite friendly)

- `AnnualDep = (Purchase Price − Salvage) / Useful Life`  (Salvage = 0)
- `Book Value = max(0, Price − AgeYears × AnnualDep)`
- `Dep Status` = No data · In progress · Fully depreciated
- Useful-life defaults: Laptop 3, Desktop 4, Monitor 5, Server 5, Printer 4, Other 3
  (a per-asset `Useful Life` column overrides when present).
- Missing `Purchase Date`/`Purchase Price` → flagged in `dataHealth`, never guessed.

## Deploy (new Vercel project)

1. Push the repo, then create a **new Vercel project** (`Assets-Summary`):
   - Framework: **Other** · Root directory: **`summary`**
   - (This must be a separate project — the existing one deploys `scanner-app`.)
2. Set **Environment Variables** (from `.env.example`):
   - `TENANT`, `CLIENT_ID`, `CLIENT_SECRET`, `SITE_URL`, `LIST_NAME`, `SUMMARY_ACCESS_KEY`
   - `CLIENT_SECRET` = the Entra app's server-side secret; `SUMMARY_ACCESS_KEY` = any long random string you choose.
3. Deploy → note the URL, e.g. `https://xana-asset-summary.vercel.app`.

### Embed in SharePoint
1. On the Xana site → **Pages** → **New** → name it “Assets Summary”.
2. Edit → **+ (Add web part)** → search **“Embed”** → choose **Embed web part**.
3. Under **Website address or embed code**, paste:
   `https://<your-project>.vercel.app/?key=<SUMMARY_ACCESS_KEY>`
4. **Save** & **Publish**. C-suite opens the page → live dashboard, fresh on every open.

> Anyone with the site page can view (site members). The `?key=` prevents casual
> direct access; rotate it by changing the env var + the embed URL.

## Local dev & tests

```powershell
cd summary
npm install
$env:CLIENT_SECRET="..."; $env:SUMMARY_ACCESS_KEY="..."; npm run dev   # vercel dev
npm test
```

## Future

- **beUI / Next.js** pivot if a motion-heavy component look is wanted.
- Wire the same JSON into **Google Sheets** (your existing dashboard) via a scheduled
  push — no logic rework.
- Migrate the source of truth to **v2 (Supabase)** when cut over; the dashboard only
  calls one JSON endpoint, so it keeps working with a new backend.
