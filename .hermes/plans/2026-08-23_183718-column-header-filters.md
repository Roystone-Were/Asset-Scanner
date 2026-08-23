# Column-Header Filtering on /assets — Design & Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the standalone filter bar with in-table filtering — each filterable column header gets a small funnel icon; clicking it opens a compact popover of value checkboxes. Sorting stays on header click, filtering via the icon.

**Architecture:** No new sections above the table. The existing `<th>` gains two hit zones: label click = sort (existing), funnel-icon click = filter popover anchored to that header. Filter state lives in a `colFilters` map (`{status:Set, type:Set, location:Set}`); active filters show as a count badge on the funnel and a one-line summary under the table title with a Clear-all link. The old `.filterbar` markup, CSS, and chip JS are deleted — single source of truth for filtering.

**Tech Stack:** vanilla JS + CSS in `assets/index.html` only (plus removing the dead chip code from the same file).

---

## Current Context (verified)

- `renderTable()` at `assets/index.html:288` builds headers: `['Tag','Type','Model','Serial','Employee','Location','Status','Purchase','Price','Book','Dep','Condition']` → each `<th data-sort="...">`, click = sort toggle.
- `applyFilters()` reads `chipSel.{status,type,location}` arrays (chip system added earlier today).
- Chip UI: `.filterbar` block in gate div + `buildChips()/syncFilterMeta()/clearFilters` handlers.
- Data available per row: `it.status`, `it.type`, `it.location` — distinct values derivable client-side.
- Sort indicator currently absent (no arrow shown) — adding one improves clarity while we're here.

## Interaction design

- **Header layout:** `LABEL [▼|▲ if sorting] [⏷ funnel if filterable]`
  - Label area = sort toggle (unchanged behavior)
  - Funnel glyph = opens filter popover
- **Filterable columns:** Type, Location, Status only (the three users actually filter). Tag/Serial/etc. stay sort-only — text search covers them.
- **Popover:** absolutely-positioned card below the th: checkbox list of distinct values (+ "Blanks" pseudo-value when nulls exist), Apply / Clear buttons. Click-outside closes without applying.
- **Active state:** funnel turns accent-green with a count dot when filters are active on that column; column cells could dim slightly (optional, skip for YAGNI).
- **Summary line:** replaces the current meta line when any column filter is active: `Filtered: Status(1) · Type(2) — Clear`

## Tasks

### Task 1: Remove chip filter bar

**Objective:** Delete the standalone filter bar and all its code paths.

**Files:**
- Modify: `assets/index.html`

**Step 1:** Remove the `.filterbar` HTML block from the gate div (the whole `<div class="filterbar" id="filterBar">…</div>` chunk).

**Step 2:** Remove CSS blocks: `.filterbar`, `.fgroup`, `.flabel`, `.chips`, `.chip-f`, `.chip-f:hover`, `.chip-f.on`, `.fmeta`, `.clearlink`.

**Step 3:** Remove JS: `chipSel`, `buildChips()`, `syncFilterMeta()`, the `clearFilters` listener, the `buildChips()` call in `load()`. Replace chip reads inside `applyFilters()` with the new `colFilters` source (Task 2).

**Step 4:** Parse check:
Run: `node -e "const fs=require('fs');const m=fs.readFileSync('assets/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g);new Function(m[m.length-1].replace(/<\/?script>/g,''));console.log('OK')"`
Expected: OK

**Step 5:** Commit

```bash
git add assets/index.html
git commit -m "refactor: remove chip filter bar (replaced by in-header filters)"
```

---

### Task 2: Column filter state + applyFilters integration

**Objective:** `colFilters` map drives filtering; distinct values computed per column.

**Files:**
- Modify: `assets/index.html`

**Step 1: State + helpers**

```js
// ---------- column filters ----------
const colFilters={type:new Set(),location:new Set(),status:new Set()};
const FILTERABLE={Type:"type",Location:"location",Status:"status"};
function distinctValues(key){
  const s=new Set();
  for(const it of allItems){
    const v=(it[key]||"").toString().trim();
    s.add(v||"(blank)");
  }
  return [...s].sort((a,b)=>a.localeCompare(b));
}
function colFilterCount(){
  return Object.values(colFilters).reduce((n,set)=>n+set.size,0);
}
```

**Step 2: applyFilters uses sets**

Replace the three chip lines:

```js
if(fs.length && !fs.includes(it.status||"")) return false;
```

with set-based checks:

```js
if(colFilters.type.size && !colFilters.type.has((it.type||"").toString().trim()||"(blank)")) return false;
if(colFilters.location.size && !colFilters.location.has((it.location||"").toString().trim()||"(blank)")) return false;
if(colFilters.status.size && !colFilters.status.has((it.status||"").toString().trim()||"(blank)")) return false;
```

**Step 3: Commit**

```bash
git add assets/index.html
git commit -m "feat: column filter state model"
```

---

### Task 3: Header funnels + popover UI

**Objective:** Filterable headers render a funnel button; popover lists values with checkboxes.

**Files:**
- Modify: `assets/index.html`

**Step 1: CSS**

```css
th .fwrap{display:inline-flex;align-items:center;gap:3px;margin-left:5px}
button.funnel{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;padding:0 2px;line-height:1}
button.funnel:hover{color:var(--text)}
button.funnel.active{color:var(--accent)}
.fpop{position:absolute;z-index:30;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);min-width:170px;max-height:260px;overflow:auto}
.fpop label{display:flex;gap:7px;align-items:center;font-size:.8rem;padding:4px 2px;cursor:pointer}
.fpop .fbtns{display:flex;gap:6px;margin-top:8px}
.tbl-scroll{position:relative}   /* anchor context */
thead th{position:relative}
```

Note: popover positions itself via JS (fixed coords from `getBoundingClientRect`) because `.tbl-scroll{overflow:auto}` clips absolute children.

**Step 2: Header rendering changes in renderTable()**

Replace the head-building map with:

```js
const COLS=[["Tag","tag"],["Type","type"],["Model","model"],["Serial","serial"],["Employee","employee"],["Location","location"],["Status","status"],["Purchase","purchase"],["Price","price"],["Book","book"],["Dep","dep"],["Condition","condition"]];
const head=COLS.map(([label,key])=>{
  const fkey=FILTERABLE[label];
  const funnel=fkey?'<span class="fwrap"><button type="button" class="funnel'+(colFilters[fkey].size?" active":"")+'" data-funnel="'+fkey+'" title="Filter '+label+'">⏷</button></span>':"";
  const sorted=sortKey===key?(" "+(sortDir===1?"▲":"▲")):"";
  return '<th data-sort="'+key+'"><span class="sortlabel" data-sort="'+key+'">'+label+(sorted?" ▲":"")+"</span>"+funnel+"</th>";
}).join("");
```

(Sort arrow direction handled by sortDir state — see Task 4 polish.)

**Step 3: Popover logic**

```js
function openFunnelPop(fkey,anchorEl){
  closeFunnelPop();
  const vals=distinctValues(fkey);
  const pop=document.createElement("div");
  pop.className="fpop"; pop.id="funnelPop";
  pop.innerHTML='<div style="font-weight:600;font-size:.75rem;margin-bottom:6px;text-transform:capitalize">'+fkey+'</div>'+
    vals.map(v=>'<label><input type="checkbox" value="'+esc(v)+'" '+(colFilters[fkey].has(v)?"checked":"")+"/> "+esc(v)+"</label>").join("")+
    '<div class="fbtns"><button type="button" class="btn" id="fpApply">Apply</button><button type="button" class="btn secondary" id="fpClear">Clear</button></div>';
  document.body.appendChild(pop);
  const r=anchorEl.getBoundingClientRect();
  pop.style.top=(r.bottom+window.scrollY+6)+"px";
  pop.style.left=Math.min(r.left+window.scrollX, window.scrollX+document.documentElement.clientWidth-pop.offsetWidth-8)+"px";
  pop.querySelector("#fpApply").addEventListener("click",()=>{
    colFilters[fkey]=new Set([...pop.querySelectorAll("input:checked")].map(i=>i.value));
    closeFunnelPop(); applyFilters();
  });
  pop.querySelector("#fpClear").addEventListener("click",()=>{
    colFilters[fkey]=new Set();
    closeFunnelPop(); applyFilters();
  });
}
function closeFunnelPop(){document.getElementById("funnelPop")?.remove();}
document.addEventListener("click",e=>{
  if(e.target.closest(".funnel")||e.target.closest("#funnelPop"))return;
  closeFunnelPop();
});
```

Wire clicks in renderTable():

```js
main.querySelectorAll("button[data-funnel]").forEach(b=>b.addEventListener("click",(ev)=>{
  ev.stopPropagation();
  openFunnelPop(b.dataset.funnel,b);
}));
```

And guard the existing sort handler so funnel clicks don't also trigger sort:

In the `th[data-sort]` listener, first line: `if(e.target.closest(".funnel"))return;`

**Step 4: Meta line shows filter state**

In renderTable()'s "Showing…" div, append when `colFilterCount()>0`:

```js
' · <b>filtered</b> ('+[...Object.entries(colFilters)].filter(([,s])=>s.size).map(([k,s])=>k+"("+s.size+")").join(", ")+') — <a href="#" id="clearColFilters" style="color:var(--accent)">clear</a>'
```

with a delegated listener for `#clearColFilters`.

**Step 5: Verify parse + manual test**

Run parse-check (as Task 1). Manual: click funnel on Status → checkbox list appears → tick "In Use" → Apply → table filters; funnel turns green; sort still works via label click.

**Step 6: Commit**

```bash
git add assets/index.html
git commit -m "feat: in-header column filters with popover checkboxes"
```

---

### Task 4: Sort indicator arrows (polish)

**Objective:** Sorted column shows ▲/▼ next to its label — clarifies sort vs filter affordances.

**Files:**
- Modify: `assets/index.html` (head template + sort handler re-render already triggers it)

**Step 1:** In head template use:

```js
const arrow=(sortKey===key)?(sortDir===1?" ▲":" ▼"):"";
'<span class="sortlabel" data-sort="'+key+'">'+label+arrow+"</span>"
```

**Step 2:** Verify: click "Tag" → ▲ appears; click again → ▼.

**Step 3:** Commit

```bash
git add assets/index.html
git commit -m "feat: sort direction arrows on table headers"
```

---

### Task 5: Deploy + verify matrix

**Step 1:** `git push origin main && npx vercel deploy --prod --yes`

**Step 2:** Matrix:
- Funnel on Status/Type/Location only — other headers have no funnel ✓
- Tick multiple values → Apply → rows reduce; badge count on funnel ✓
- Clear in popover → column unfiltered ✓
- Click-outside closes popover without changing filters ✓
- Sorting unaffected (label click toggles asc/desc with arrows) ✓
- Search box composes with column filters ✓
- Dark mode legible (popover colors from tokens) ✓

## Files Likely to Change

| File | Change |
|---|---|
| `assets/index.html` | remove filterbar; add funnel/popover UI, state, CSS; sort arrows |

## Tests / Validation

1. Parse-check inline script after every edit step.
2. Full suite: `npm --prefix scanner-app test` (untouched, must stay 41 pass).
3. Production matrix above after deploy.

## Risks / Tradeoffs / Open Questions

- **Popover clipping:** solved by appending to `document.body` with fixed coordinates rather than nesting inside `.tbl-scroll`.
- **Horizontal scroll misalignment:** popover anchors to viewport coords captured at open-time; scrolling the table mid-open leaves it briefly misplaced — acceptable; any click closes it.
- **YAGNI note:** deliberately NOT doing per-column text-search filters, date-range filters, or saved filter presets until asked.
