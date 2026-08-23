# Data Quality Sprint (§10) — REVISED: auto-generated placeholder tags

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Trustworthy register without blocking field work — asset tags are AUTO-GENERATED placeholders (user has no physical tags yet), serial/department/price validation enforced, estimate-pending flag honest on the dashboard.

**Architecture:** Same two-layer approach as before (form validation + DB backstop), with one change from the original plan: **Asset Tag is never user-entered.** On opening the add form, the system proposes the next placeholder tag `XL-<item_id>` (e.g. `XL-123`); the field is read-only but overridable via an "edit" affordance for when physical tags eventually exist. Serial becomes the human-keyed identifier and is required. This kills the 109-missing-tags problem permanently instead of backfilling it.

**Tech Stack:** unchanged — Supabase migrations via `scripts/apply-migration.mjs`, vanilla JS in `assets/index.html` + `js/supabase-client.js`, node:test in `scanner-app/test/`.

---

## Revision rationale (vs 2026-08-23_145439 plan)

Original plan required the *user* to type a tag at creation. Roystone clarified: assets don't have physical tags yet. Forcing typed tags would produce invented garbage. Instead:
- System proposes `XL-<next_item_id>` as the tag automatically
- Field shows it as read-only with a small "✎ assign manually" toggle
- When real label printing starts later, tags get re-assigned deliberately (the ✎ path)
- DB constraint stays satisfied because a tag always exists

---

## Tasks

### Task 1: Department choices + variant cleanup migration

**Objective:** Canonical department list seeded; dirty variants normalized.

**Files:**
- Create: `supabase/migrations/0012_department_choices_and_cleanup.sql`

**Step 1: Inspect live variants first**

Run:
```bash
node -e "
import('fs').then(async fs=>{
  const env={};
  for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const i=l.indexOf('=');if(i>0)env[l.slice(0,i).trim()]=l.slice(i+1).trim();}
  const {default:pg}=await import('pg');
  const m=env.SUPABASE_DB_URL.match(/^(postgresql:\/\/)([^:@\/]+):([^@]*)@(.*)\$/);
  const c=new pg.Client({connectionString:m[1]+encodeURIComponent(m[2])+':'+encodeURIComponent(m[3])+'@'+m[4]});
  await c.connect();
  console.log(JSON.stringify((await c.query(\"select coalesce(extra->>'department','(none)') d, count(*)::int n from public.assets group by 1 order by n desc\")).rows));
  await c.end();
})"
```
Expected: list of live department values + counts. Adjust canonical mapping below to match reality.

**Step 2: Write migration**

```sql
-- 0012: departments become admin-managed choices; normalize known variants.
insert into public.app_choices (category, value, sort_order) values
  ('department','IT',1),
  ('department','Operations',2),
  ('department','Finance and Admin',3),
  ('department','Pharmacy',4),
  ('department','Procurement',5),
  ('department','Sales',6),
  ('department','HR',7)
on conflict (category,value) do nothing;

-- normalize known misspellings / case variants
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Operations"')
  where extra->>'department' ~* 'oper[ae]?r?ations';
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"Finance and Admin"')
  where extra->>'department' ~* 'fin[ae]nc?e\s*(and|&)\s*admin';
update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{department}','"IT"')
  where lower(extra->>'department') in ('it','i.t.');
```

**Step 3: Apply**

Run: `node scripts/apply-migration.mjs supabase/migrations/0012_department_choices_and_cleanup.sql`
Expected: `HTTP 201`

**Step 4: Verify**

Re-run Step 1 query. Expected: only canonical names (+ "(none)") remain.

**Step 5: Commit**

```bash
git add supabase/migrations/0012_department_choices_and_cleanup.sql
git commit -m "feat(db): department choices seeded, dirty variants normalized"
```

---

### Task 2: Department dropdown + auto-generated placeholder tag on add form

**Objective:** Department is select-only; Asset Tag auto-fills `XL-<id>` read-only with manual override toggle.

**Files:**
- Modify: `assets/index.html:155-162` (form fields)

**Step 1: Replace tag input (line 155)**

```html
<label>Asset Tag <span style="font-size:.65rem;color:var(--muted)">(auto — <a href="#" id="tagManual">assign manually</a>)</span></label>
<input type="text" id="addTag" readonly placeholder="auto-generated on save" />
```

**Step 2: Replace dept input (line 162)**

```html
<label>Department</label><select id="addDept"><option value="">— select —</option></select>
```

**Step 3: Wire population in `startApp()` (after applyRoleNav)**

```js
try{
  const {data}=await XanaSupabase.client().from("app_choices").select("value").eq("category","department").order("sort_order");
  for(const r of data||[]) document.getElementById("addDept").insertAdjacentHTML("beforeend",'<option>'+esc(r.value)+'</option>');
}catch(e){}
document.getElementById("tagManual")?.addEventListener("click",e=>{
  e.preventDefault();
  document.getElementById("addTag").removeAttribute("readonly");
  document.getElementById("addTag").focus();
});
```

Note: the tag itself is finalized at save-time (`Task 3`) so concurrent adds can't collide; the visible "auto" text before save is indicative only.

**Step 4: Verify manually**

Open add form. Expected: Department dropdown populated; Tag field greyed with placeholder; clicking "assign manually" unlocks typing.

**Step 5: Commit**

```bash
git add assets/index.html
git commit -m "feat: auto placeholder tags + department dropdown on add form"
```

---

### Task 3: Save-time validation + tag generation

**Objective:** Serial & department required; price required-or-estimate; tag auto-assigned `XL-<allocated item_id>` unless manually overridden.

**Files:**
- Modify: `assets/index.html:369-405` (`addSave` handler)
- Modify: `js/supabase-client.js:35-45` (`FORM_EXTRA_MAP`) and `insertAsset` (~line 287)

**Step 1: Adapter — expose estimate flag**

In `FORM_EXTRA_MAP` add:

```js
EstimatePending: "estimate_pending",
```

**Step 2: insertAsset gains optional pre-set tag handling**

Current signature already accepts any row; no adapter change needed beyond FORM_EXTRA_MAP — the form will compute the tag itself using the same RPC the allocator uses:

In `assets/index.html` `addSave` handler, replace existing validation block with:

```js
const est=document.getElementById("addPriceEstimate").checked;
const priceRaw=(document.getElementById("addPrice").value||"").trim();
const manualTag=!document.getElementById("addTag").hasAttribute("readonly")
  ? (document.getElementById("addTag").value||"").trim() : "";
const problems=[];
if(!serial) problems.push("Serial Number is required.");
if(!dept) problems.push("Department is required.");
if(priceRaw===""&&!est) problems.push("Purchase Price is required — or tick “estimate pending”.");
if(manualTag&&!serial&&!est){/*noop*/}
if(problems.length){
  msg.innerHTML='<div class="msg err">'+problems.map(p=>"• "+esc(p)).join("<br>")+'</div>';
  return;
}
if(est) fields.EstimatePending=true;
if(manualTag){ fields.Title=manualTag; }
```

Then after successful `XanaSupabase.insertAsset(fields)` call returns `created`, if NO manual tag was set, immediately rename to the placeholder:

```js
if(!manualTag){
  try{ await XanaSupabase.updateAsset(created.id,{Title:"XL-"+created.id}); }catch(e){console.warn(e);}
}
```

This guarantees unique tags (item_id is unique) without a separate counter.

**Step 3: Add estimate checkbox to form HTML (after line 165)**

```html
<label class="chk"><input type="checkbox" id="addPriceEstimate" /> Price is an estimate (pending invoice)</label>
```

**Step 4: Verify manually**

- Save with blank serial → blocked, bullets shown.
- Fill all, leave price blank, tick estimate → saves; Supabase row shows `extra.estimate_pending=true`, `asset_tag="XL-<newId>"`.
- Click "assign manually", type custom tag → saves with that tag.

**Step 5: Commit**

```bash
git add assets/index.html js/supabase-client.js
git commit -m "feat: auto XL-tags, serial/dept/price enforcement, estimate flag at creation"
```

---

### Task 4: DB backstop constraint

**Objective:** No asset may exist without a tag; price-or-estimate rule enforced server-side.

**Files:**
- Create: `supabase/migrations/0013_asset_quality_constraints.sql`

**Step 1: Write migration**

```sql
-- Every asset must have a usable tag (placeholder XL-* or manual).
alter table public.assets drop constraint if exists assets_tag_required;
alter table public.assets
  add constraint assets_tag_required
  check (coalesce(nullif(asset_tag,''),nullif(title,'')) is not null);

-- Price must be recorded OR flagged as estimate.
alter table public.assets drop constraint if exists assets_price_or_estimate;
alter table public.assets
  add constraint assets_price_or_estimate
  check (
    coalesce(nullif(extra->>'purchase_price',''),'') <> ''
    or (extra->>'estimate_pending') in ('true','true::boolean') or (extra->>'estimate_pending')::boolean is true
    or (extra->>'estimate_pending') = 'true'
  );
```

Simplify before applying — final version of second check:

```sql
alter table public.assets drop constraint if exists assets_price_or_estimate;
alter table public.assets
  add constraint assets_price_or_estimate
  check (
    coalesce(nullif(extra->>'purchase_price',''),'') <> ''
    or (extra->>'estimate_pending')::boolean is true
  );
```

(If jsonb stores JS true it reads as boolean already; if string "true" the ::boolean cast handles it.)

**Step 2: Pre-clean rows that violate**

Run `scripts/backfill-quality.mjs` (Task 5) FIRST; fix or flag listed rows. Then apply:

Run: `node scripts/apply-migration.mjs supabase/migrations/0013_asset_quality_constraints.sql`
Expected: `HTTP 201`. Failure naming rows = those need attention first.

**Step 3: Commit**

```bash
git add supabase/migrations/0013_asset_quality_constraints.sql
git commit -m "feat(db): tag-required + price-or-estimate constraints"
```

---

### Task 5: Backfill report script (run BEFORE Task 4)

**Objective:** List existing violations; auto-fix what's safe (missing tag → XL- placeholder); surface the rest for decisions.

**Files:**
- Create: `scripts/backfill-quality.mjs`

**Step 1: Write script**

```js
import fs from 'fs';
import pg from 'pg';

function loadEnv(){ /* copy loadEnv verbatim from scripts/clean-e2e-assets.mjs */ }
function dbUrl(raw){ /* copy dbUrl verbatim from scripts/clean-e2e-assets.mjs */ }

const c = new pg.Client({ connectionString: dbUrl(loadEnv().SUPABASE_DB_URL) });
await c.connect();

// 1. Missing tags -> auto-fill XL-<item_id> (safe: reversible, deterministic)
const fixable = await c.query(
  "update public.assets set asset_tag='XL-'||item_id, title=coalesce(nullif(title,''),'XL-'||item_id) where coalesce(nullif(asset_tag,''),nullif(title,'')) is null returning item_id"
);
console.log(`auto-tagged ${fixable.rowCount} assets as XL-<item_id>`);

// 2. Missing price WITHOUT estimate flag -> report only
const noPrice = await c.query(
  "select item_id, coalesce(asset_tag,title) tag from public.assets where coalesce(nullif(extra->>'purchase_price',''),'')='' and coalesce(extra->>'estimate_pending','')='' order by item_id"
);
console.log(`still missing price (${noPrice.rowCount}):`);
for (const r of noPrice.rows) console.log(`  #${r.item_id} ${r.tag}`);

// 3. Missing serial -> report only
const noSerial = await c.query(
  "select item_id, coalesce(asset_tag,title) tag from public.assets where coalesce(nullif(serial,''),'')='' order by item_id"
);
console.log(`missing serial (${noSerial.rowCount}):`);
for (const r of noSerial.rows.slice(0,30)) console.log(`  #${r.item_id} ${r.tag}`);

await c.end();
```

**Step 2: Run it**

Run: `node scripts/backfill-quality.mjs`
Expected: counts printed; review the missing-price list with Roystone — either enter real prices via `/assets` edit or bulk-flag estimates.

**Step 3: Bulk-flag remaining price gaps as estimates (after review)**

Run when approved:

```bash
node -e "
import('fs').then(async fs=>{
  const env={};
  for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const i=l.indexOf('=');if(i>0)env[l.slice(0,i).trim()]=l.slice(i+1).trim();}
  const {default:pg}=await import('pg');
  const m=env.SUPABASE_DB_URL.match(/^(postgresql:\/\/)([^:@\/]+):([^@]*)@(.*)\$/);
  const c=new pg.Client({connectionString:m[1]+encodeURIComponent(m[2])+':'+encodeURIComponent(m[3])+'@'+m[4]});
  await c.connect();
  const r=await c.query(\"update public.assets set extra=coalesce(extra,'{}'::jsonb)||'{\\\"estimate_pending\\\":true}'::jsonb where coalesce(nullif(extra->>'purchase_price',''),'')='' returning item_id\");
  console.log('flagged', r.rowCount, 'as estimate-pending');
  await c.end();
})";
```

**Step 4: NOW apply Task 4's migration** (will succeed — zero violators remain).

**Step 5: Commit**

```bash
git add scripts/backfill-quality.mjs
git commit -m "chore: quality backfill — auto XL-tags, estimate flags, violation report"
```

---

### Task 6: Dashboard honesty — confirmed vs estimate-pending book value

**Objective:** Totals distinguish confident numbers from estimates.

**Files:**
- Modify: `js/supabase-client.js` — `enrichAsset` (~line 150 return block), `computeSummary` totals (~line 214)
- Test: `scanner-app/test/logic.test.js`
- Modify: `summary/index.html` (KPI sub-label)

**Step 1: Write failing test** (append to logic.test.js, matching its import style):

```js
test("computeSummary separates estimate-pending book value", () => {
  const items=[
    {tag:"A",purchasePrice:1000,bookValue:800,depStatus:"In progress",usefulLife:3,type:"Laptop",estimatePending:false},
    {tag:"B",purchasePrice:500,bookValue:400,depStatus:"In progress",usefulLife:3,type:"Laptop",estimatePending:true},
  ];
  const s=XanaSupabase.computeSummary(items);
  assert.equal(s.totals.confirmedBookValue,800);
  assert.equal(s.totals.bookValue,1200);
  assert.equal(s.totals.estimatePendingCount,1);
});
```

**Step 2: Run to verify failure**

Run: `npm --prefix scanner-app test`
Expected: FAIL (confirmedBookValue undefined).

**Step 3: Implement**

`enrichAsset` return adds:

```js
estimatePending: extra.estimate_pending===true||extra.estimate_pending==="true",
```

`computeSummary` totals adds:

```js
const pending=it.filter(i=>i.estimatePending);
estimatePendingCount:pending.length,
confirmedBookValue:Math.round(sum(it.filter(i=>!i.estimatePending),i=>i.bookValue)*100)/100,
```

**Step 4: Run tests to verify pass**

Run: `npm --prefix scanner-app test`
Expected: all green.

**Step 5: Surface on dashboard**

Under Book Value KPI in `summary/index.html`, when `estimatePendingCount>0` render:
`includes <N> estimate-pending · confirmed KES <confirmedBookValue>`

**Step 6: Commit**

```bash
git add js/supabase-client.js scanner-app/test/logic.test.js summary/
git commit -m "feat: confirmed vs estimate-pending book value split"
```

---

### Task 7: Header clarity + health target annotation

**Objective:** Non-IT viewers understand every column; Data Health carries target + owner.

**Files:**
- Modify: `summary/index.html`, `assets/index.html` (labels), `Health-Check.ps1` (by-location unverified table)

**Step 1: Find cryptic labels**

Run: `grep -n ">BO<\|>Dep<\|BO \|Dep " summary/index.html summary/app.js assets/index.html`

**Step 2: Rename** — "BO"→"Book value", "Dep"→"Depreciation status". Pure copy edits.

**Step 3: Add under Data Health panel (summary page):**

```html
<p style="font-size:.75rem;color:var(--muted)">Target ≥95% within 60 days · owner: Roystone</p>
```

**Step 4: Extend Health-Check.ps1** unverified-assets section to also group by location (mirror existing duplicate-serial grouping pattern) so the monthly issue shows which branch owes the walk.

**Step 5: Commit**

```bash
git add summary/ assets/index.html Health-Check.ps1
git commit -m "feat: header clarity, health target note, unverified-by-location in monthly report"
```

---

## Files Likely to Change

| File | Change |
|---|---|
| `supabase/migrations/0012_department_choices_and_cleanup.sql` | new |
| `supabase/migrations/0013_asset_quality_constraints.sql` | new |
| `assets/index.html` | auto-tag UI, dept dropdown, validation, estimate checkbox |
| `js/supabase-client.js` | FORM_EXTRA_MAP + enrichAsset + computeSummary |
| `summary/index.html` | KPI sub-labels, header renames, target line |
| `scanner-app/test/logic.test.js` | new test |
| `scripts/backfill-quality.mjs` | new |
| `Health-Check.ps1` | by-location grouping |

## Tests / Validation

1. `npm --prefix scanner-app test` — green after Task 6, untouched files unaffected elsewhere.
2. Manual add-form matrix: blank serial blocks; estimate path saves with `XL-<id>` tag + flag; manual override respected.
3. DB probe post-Task-4: REST insert without price/flag → CHECK violation expected.
4. Post-backfill probe: `select count(*) from assets where coalesce(nullif(asset_tag,''),nullif(title,'')) is null` → 0.
5. CI gate: push main → GitHub Actions `test` green → Vercel alias success → spot-check live `/assets`.

## Risks / Tradeoffs / Open Questions

- **XL-\* tags are provisional by design.** When physical labeling begins, use the ✎ override per asset or a bulk re-map script. Constraint keeps them non-empty meanwhile.
- **Estimate flag is self-reported** — acceptable now; quarterly audit walks close accuracy.
- **Department canonical list** must be confirmed against Task 1 Step 1 output before applying — values above are hypotheses.
- **Backfill mutates data** (auto-tagging, estimate flags): both steps are individually reversible (tags map 1:1 to item_id; flags removable), but run the report step and eyeball counts before each write.
- **Open question (deferred):** should serial stay mandatory forever? Furniture/fixture assets may legitimately lack one. Current answer: yes, revisit if it blocks real entries.
