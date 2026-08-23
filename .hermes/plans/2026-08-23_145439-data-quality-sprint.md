# Data Quality Sprint (§10) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the asset register trustworthy — required fields enforced at creation, department locked to a clean dropdown, price either real or flagged "estimate pending", and the dashboard honest about which numbers are confident.

**Architecture:** All validation lives in two places: the `/assets` add form (user-facing checks) and a Supabase CHECK constraint (database backstop). Department values move from free text into the existing `app_choices` table (category `department`), with a one-time SQL migration mapping the known misspellings. The estimate-pending flag is a new key inside the existing `extra` JSONB blob — no new column, no migration beyond the constraint. Dashboard changes read the new flag via the existing `enrichAsset` pipeline.

**Tech Stack:** Supabase Postgres (migrations applied via `scripts/apply-migration.mjs`), vanilla JS apps (`assets/index.html`, `js/supabase-client.js`), node:test suite in `scanner-app/test/`.

---

## Current Context

- **Add form:** `assets/index.html:369-404` (`addSave` handler). Tag is marked required with an asterisk but only checked client-side; serial, price optional.
- **Department:** free text input at `assets/index.html:162` (`addDept`). Known dirty variants in data: "Operations"/"Operartions", "Finance and Admin"/"Finance And Admin"/"Finace And Admin".
- **Price:** `addPrice` numeric input at `assets/index.html:163`; blank → stored as absent → dashboard reads KES 0 silently (`enrichAsset` in `js/supabase-client.js:129-135` coerces null → 0).
- **DB:** `assets.extra` is JSONB; no NOT NULL / CHECK constraints on tag or price. Migration pattern established (`scripts/apply-migration.mjs`, migrations 0001–0011).
- **Choices table:** `app_choices(category, value, sort_order)` exists (migration 0008), already feeds Status/Location/Type dropdowns in scanner + admin.
- **Dashboard compute:** `computeSummary()` in `js/supabase-client.js:170-242`; `dataHealth` block already reports missingSerial/missingTag/unverified counts. Consumed by `summary/app.js`.
- **Tests:** `scanner-app/test/logic.test.js` + `golden.test.js` run with `npm --prefix scanner-app test`. Pure functions from `logic.js` and `js/supabase-client.js` are importable there.

## Assumptions

1. One-time backfill session for existing blank-tag rows happens BEFORE enforcement goes live (plan includes the cleanup queries; running them is a human+data step).
2. "Estimate pending" assets still store whatever number the user typed (may be 0); the flag drives reporting treatment, not storage.
3. No schema column additions — everything rides `extra` JSONB and `app_choices`.

---

## Step-by-Step Plan

### Task 1: Seed department choices + backfill dirty variants

**Objective:** `app_choices` has a canonical department list; every existing asset's misspelled department maps to a clean one.

**Files:**
- Create: `supabase/migrations/0012_department_choices_and_cleanup.sql`

**Step 1: Write the migration**

```sql
-- 0012: departments become admin-managed choices; clean known variants.

insert into public.app_choices (category, value, sort_order)
values
  ('department','IT',1),
  ('Operations',null,2) -- placeholder removed below; real list:
on conflict do nothing;
delete from public.app_choices where category='department' and value is null;

insert into public.app_choices (category, value, sort_order)
values
  ('department','IT',1),
  ('department','Operations',2),
  ('department','Finance and Admin',3),
  ('department','Pharmacy',4),
  ('department','Procurement',5),
  ('department','Sales',6),
  ('department','HR',7)
on conflict (category,value) do nothing;

-- one-time normalization of known dirty variants in assets.extra->>department
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"IT"')
  where extra->>'department' in ('it','It');
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Operations"')
  where extra->>'department' ilike 'oper%';
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Finance and Admin"')
  where extra->>'department' ~* 'fin[ae]nc?e\s*and\s*admin';
```

Note: adjust the canonical list to reality before applying — check live variants first:

```bash
node -e "
import('fs').then(async fs=>{
  const env={};
  for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const i=l.indexOf('=');if(i>0)env[l.slice(0,i).trim()]=l.slice(i+1).trim();}
  const {default:pg}=await import('pg');
  const m=env.SUPABASE_DB_URL.match(/^(postgresql:\/\/)([^:@\/]+):([^@]*)@(.*)\$/);
  const c=new pg.Client({connectionString:m[1]+encodeURIComponent(m[2])+':'+encodeURIComponent(m[3])+'@'+m[4]});
  await c.connect();
  console.log(JSON.stringify((await c.query(\"select extra->>'department' d, count(*)::int n from public.assets group by 1 order by n desc\")).rows));
  await c.end();
})"
```

**Step 2: Apply**

Run: `node scripts/apply-migration.mjs supabase/migrations/0012_department_choices_and_cleanup.sql`
Expected: `HTTP 201`

**Step 3: Verify no dirty variants remain**

Re-run the variant-count query above. Expected: only canonical names remain.

**Step 4: Commit**

```bash
git add supabase/migrations/0012_department_choices_and_cleanup.sql
git commit -m "feat(db): department choices seeded, dirty variants normalized"
```

---

### Task 2: Department dropdown on the add form

**Objective:** `addDept` becomes a `<select>` fed by app_choices — free text impossible.

**Files:**
- Modify: `assets/index.html:162`

**Step 1: Swap the input for a select**

Replace line 162:

```html
<label>Department</label><input type="text" id="addDept" placeholder="Department" />
```

with:

```html
<label>Department</label><select id="addDept"><option value="">— select —</option></select>
```

**Step 2: Populate it on page load**

In the boot section of `assets/index.html` (after `XanaSupabase.applyRoleNav(roles)` inside `startApp()`), add:

```js
try{
  const {data}=await XanaSupabase.client().from("app_choices").select("value").eq("category","department").order("sort_order");
  for(const r of data||[]) document.getElementById("addDept").insertAdjacentHTML("beforeend",'<option>'+esc(r.value)+'</option>');
}catch(e){/* fall back to empty select */}
```

**Step 3: Verify manually**

Run local server, open `/assets`, click + Add Asset. Expected: Department is a dropdown with the 7 canonical values; typing is impossible.

**Step 4: Commit**

```bash
git add assets/index.html
git commit -m "feat: department is dropdown from app_choices on add form"
```

---

### Task 3: Required-field validation (tag, serial, department, price)

**Objective:** Save blocked with clear inline errors when tag/serial/department are blank or price is absent-without-estimate-flag.

**Files:**
- Modify: `assets/index.html:155-168` (form HTML), `assets/index.html:369-385` (validation in addSave)

**Step 1: Add the estimate checkbox to the form**

After the Purchase Price label/input line, insert:

```html
<label class="chk"><input type="checkbox" id="addPriceEstimate" /> Price is an estimate (pending invoice)</label>
```

**Step 2: Write validation into addSave handler**

Immediately after `const msg=document.getElementById("addMsg");` insert:

```js
const est=document.getElementById("addPriceEstimate").checked;
const priceRaw=(document.getElementById("addPrice").value||"").trim();
const problems=[];
if(!tag) problems.push("Asset Tag is required.");
if(!serial) problems.push("Serial Number is required.");
if(!dept) problems.push("Department is required.");
if(priceRaw===""&&!est) problems.push("Purchase Price is required — or tick “estimate pending”.");
if(problems.length){
  msg.innerHTML='<div class="msg err">'+problems.map(p=>"• "+esc(p)).join("<br>")+'</div>';
  return;
}
```

And change the fields assembly so the estimate flag persists:

```js
if(est) fields.EstimatePending=true;   // FORM_EXTRA_MAP addition below
```

**Step 3: Register EstimatePending in the adapter**

In `js/supabase-client.js` `FORM_EXTRA_MAP` (line ~35) add:

```js
EstimatePending: "estimate_pending",
```

**Step 4: Verify manually**

Try saving with each field blank in turn. Expected: bullet list of all problems, no request sent. Fill everything, tick estimate, leave price blank → saves fine, `extra.estimate_pending=true` visible in Supabase row.

**Step 5: Commit**

```bash
git add assets/index.html js/supabase-client.js
git commit -m "feat: enforce tag/serial/department/price at creation, estimate-pending flag"
```

---

### Task 4: DB backstop constraints

**Objective:** Even a rogue client can't save an asset without tag or (price or estimate flag).

**Files:**
- Create: `supabase/migrations/0013_asset_quality_constraints.sql`
- Modify: `js/supabase-client.js` (`fieldsToRow` must surface `asset_tag` for the check)

**Step 1: Write the migration**

```sql
-- Backstop: tag always present; price present unless flagged as estimate.
alter table public.assets drop constraint if exists assets_tag_required;
alter table public.assets
  add constraint assets_tag_required
  check (coalesce(nullif(asset_tag,''),nullif(title,'')) is not null);

alter table public.assets drop constraint if exists assets_price_or_estimate;
alter table public.assets
  add constraint assets_price_or_estimate
  check (
    (extra->>'purchase_price') is not null
    or (extra->>'estimate_pending') = 'true'
  );
```

Note: apply ONLY after Task 5's backfill passes — otherwise existing rows violate and the ALTER fails loudly (which is the point).

**Step 2: Apply**

Run: `node scripts/apply-migration.mjs supabase/migrations/0013_asset_quality_constraints.sql`
Expected: `HTTP 201`. If it fails naming rows, those rows need the §10 backfill first.

**Step 3: Commit**

```bash
git add supabase/migrations/0013_asset_quality_constraints.sql
git commit -m "feat(db): tag + price-or-estimate constraints as creation backstop"
```

---

### Task 5: One-time data cleanup queries (human-assisted)

**Objective:** Existing rows satisfy the new constraints before they're applied.

**Files:**
- Create: `scripts/backfill-quality.mjs`

**Step 1: Write the report/backfill script**

Script should print (not fix, except where noted) three lists using the service key:
1. Assets with blank tag → propose title-derived tag, apply with confirmation flag
2. Assets missing purchase_price → list only (business decision per asset)
3. Assets missing serial → list only

Skeleton:

```js
import fs from 'fs';
import pg from 'pg';
// loadEnv/dbUrl copied verbatim from scripts/clean-e2e-assets.mjs
const rows = await q("select item_id, title, asset_tag, extra from public.assets order by item_id");
const noTag   = rows.filter(r => !r.asset_tag && !r.title);
const noPrice = rows.filter(r => !(r.extra?.purchase_price));
const noSerial= rows.filter(r => !r.serial);
console.log('no tag:', noTag.length, '| no price:', noPrice.length, '| no serial:', noSerial.length);
console.table(noTag.slice(0,20)); console.table(noPrice.slice(0,20)); console.table(noSerial.slice(0,20));
```

**Step 2: Run, review output with Roystone, decide per-list handling**

Run: `node scripts/backfill-quality.mjs`

**Step 3: Re-run until no-tag count is 0; price/serial lists get explicit sign-off or estimate flags**

**Step 4: Only now apply Task 4's migration**

**Step 5: Commit**

```bash
git add scripts/backfill-quality.mjs
git commit -m "chore: quality backfill report script"
```

---

### Task 6: Dashboard honesty — estimate-pending & confidence split

**Objective:** Book-value totals exclude estimate-pending assets; dashboard shows both "confirmed book value" and "includes estimates" figures plus the pending count.

**Files:**
- Modify: `js/supabase-client.js` `enrichAsset` (~line 150) and `computeSummary` (~line 214)
- Test: `scanner-app/test/logic.test.js`

**Step 1: Write failing test**

Append to `scanner-app/test/logic.test.js` (adapt import style to match existing tests):

```js
test("computeSummary separates estimate-pending assets", () => {
  const items = [
    { tag:"A", purchasePrice:1000, bookValue:800, depStatus:"In progress", usefulLife:3, type:"Laptop", estimatePending:false },
    { tag:"B", purchasePrice:500,  bookValue:400, depStatus:"In progress", usefulLife:3, type:"Laptop", estimatePending:true },
  ];
  const s = XanaSupabase.computeSummary(items);
  assert.equal(s.totals.confirmedBookValue, 800);
  assert.equal(s.totals.bookValue, 1200);
  assert.equal(s.totals.estimatePendingCount, 1);
});
```

**Step 2: Run test to verify failure**

Run: `npm --prefix scanner-app test`
Expected: FAIL — `confirmedBookValue` undefined.

**Step 3: Implement**

In `enrichAsset` return object add:

```js
estimatePending: extra.estimate_pending === true || extra.estimate_pending === "true",
```

In `computeSummary` totals add:

```js
const pending = it.filter(i => i.estimatePending);
estimatePendingCount: pending.length,
confirmedBookValue: Math.round(sum(it.filter(i=>!i.estimatePending), i=>i.bookValue)*100)/100,
```

**Step 4: Run tests to verify pass**

Run: `npm --prefix scanner-app test`
Expected: all pass including new test.

**Step 5: Surface in dashboard UI (`summary/index.html`)**

Where book-value KPI renders, add sub-label when `estimatePendingCount > 0`:
"includes N estimate-pending · confirmed KES <confirmedBookValue>".

**Step 6: Commit**

```bash
git add js/supabase-client.js scanner-app/test/logic.test.js summary/index.html summary/app.js
git commit -m "feat: confirmed vs estimate-pending book value on dashboard"
```

---

### Task 7: Verification workflow nudge + header clarity pass

**Objective:** Unverified aging visible on IT view; cryptic headers renamed.

**Files:**
- Modify: `summary/index.html` (headers), `.github/workflows/data-health.yml` (subject lines already exist — add branch breakdown line)

**Step 1: Rename unclear headers**

Grep dashboard + assets pages for single-letter/abbreviated column labels ("BO", etc.) and replace:
- "BO" → "Book value"
- "Dep" → "Depreciation status"

Run to find them: `grep -n ">BO<\|>Dep<" summary/index.html assets/index.html`

**Step 2: Add health target line under Data Health panel**

```html
<p style="font-size:.75rem;color:var(--muted)">Target ≥95% within 60 days — owner: Roystone</p>
```

**Step 3: Extend monthly data-health workflow output with unverified-by-location table**

Modify `Health-Check.ps1` group-by section to also emit counts grouped by location (pattern already exists for duplicates table).

**Step 4: Commit**

```bash
git add summary/index.html assets/index.html Health-Check.ps1 .github/workflows/data-health.yml
git commit -m "feat: header clarity, health target annotation, unverified by-branch in health report"
```

---

## Files Likely to Change (summary)

| File | Change |
|---|---|
| `supabase/migrations/0012_department_choices_and_cleanup.sql` | new |
| `supabase/migrations/0013_asset_quality_constraints.sql` | new |
| `assets/index.html` | dept dropdown, validation, estimate checkbox |
| `js/supabase-client.js` | FORM_EXTRA_MAP entry, enrichAsset flag, computeSummary split |
| `summary/index.html` + `summary/app.js` | KPI sub-labels, header renames |
| `scanner-app/test/logic.test.js` | new test |
| `scripts/backfill-quality.mjs` | new |
| `Health-Check.ps1` | by-location unverified table |

## Tests / Validation

1. `npm --prefix scanner-app test` — full suite green after Tasks 6 (and untouched elsewhere).
2. Manual matrix on `/assets` add form: each required field blank → blocked with bullets; estimate path saves.
3. DB probe after Task 4: attempt insert without price via REST → expect CHECK violation error.
4. Dashboard: create one estimate-pending test asset, confirm totals split appears, then delete it.
5. Deploy gate: push to main → GitHub Actions `test` workflow green; Vercel alias succeeds.

## Risks / Tradeoffs / Open Questions

- **Constraint timing:** Applying 0013 before cleaning existing rows will fail loudly by design. Sequence Tasks 5→4 strictly.
- **Canonical department list:** Must be confirmed against live data (Task 1 verification query) — the seven values above are a starting hypothesis.
- **Estimate flag trust:** It's self-reported. Acceptable for now; audit spot-checks close the gap.
- **Open question for Roystone:** Should serial be truly mandatory at creation? Some equipment (furniture?) may have none. Default plan says yes — confirm before enforcement.
- **Open question for James:** Exact Business Central CSV import format is out of scope here but adjacent; confirm before building §5 exports later.
