# Xana Asset System: what this app does

**Live:** https://xana-assets.vercel.app
**Reviewed:** 2026-09-04
**One line:** one app that registers, verifies, tracks and reports every
company asset, live from Supabase and mirrored to the SharePoint list.

Figures in this document are a snapshot from the review date. The app is the
authority; treat numbers here as illustrative.

---

## For the exec reader

### Why it exists

Every laptop, printer, POS terminal, monitor, camera and cash drawer has a tag,
a serial, an owner, a location and a value that falls over time. That used to
live in a SharePoint list which was slow on the floor, had no proof anyone had
actually seen the asset, and no audit trail. This app is the master record.
SharePoint stays as a familiar read-only view.

### Who uses it

| Person | What they do | Example |
|---|---|---|
| **IT** | Register kit, scan and verify, edit, offboard leavers, run admin | Ruiru stock take: scan `XL-207`, card opens, tap Verify |
| **Finance and similar** | Search, open any asset, read prices and book value, see history. Cannot change anything | Checking what the Syokimau cameras are worth today |
| **Execs** | Open the dashboard only: portfolio value, depreciation, warranty, idle stock | Monthly review of asset value and replacement due |

Scanning is an IT activity. It is not something wider staff are asked to do.

### The six jobs it handles

1. **Register.** Every asset in one searchable table. Search by tag, serial,
   model or employee; filter by type, status, location or department; sort any
   column with natural ordering, so `XL-2` comes before `XL-10`.
2. **Detail card.** The truth for one asset: identity, assignment, condition,
   purchase date and price, book value, depreciation status, useful life,
   warranty and when it was last verified. IT can tap any value to change it.
3. **Scanning.** Phone camera, walk mode for stock takes, or a USB barcode
   scanner. A scan opens the asset and records that someone laid eyes on it.
4. **People and offboarding.** Search a person, see everything assigned to
   them, mark it all returned in one action when they leave.
5. **Dashboard.** Portfolio value, book value, what is fully depreciated, what
   is due for replacement, idle stock, lost assets, and breakdowns by status,
   type, location and department. Plus a depreciation schedule as CSV.
6. **Admin.** Invite users and set roles, manage the dropdown vocabulary and
   the depreciation life behind each asset type, watch the SharePoint mirror,
   restore deleted assets, keep IT documents.

### What it protects against

- **Silent loss.** Everything is soft deleted into a recycle bin first.
- **Unverified inventory.** Every scan stamps who checked it and when, so the
  dashboard can show what has not been seen in 90 days.
- **Untracked change.** Every field edit is written to an audit trail with the
  person and timestamp.
- **Over-broad access.** Reading anything requires a role, and deactivating an
  account removes its access to the data, not just the screens.

---

## For the IT reader

### Routes

| Route | Who can open | What it does |
|---|---|---|
| `/` | anyone signed in | Landing, tiles filtered by role |
| `/assets` | `asset_viewer`, `scanner`, admins | Register, detail card, scanning, People |
| `/dashboard` | `dashboard_viewer`, admins | KPIs and exports, computed in the browser |
| `/admin` | `admin`, `super_admin` | Users, lists, sync health, recycle bin, documents |
| `/login` | public | Magic link or password, forced change on first sign-in |
| `/scan` | redirect | Permanent redirect to `/assets` |

### Roles

`super_admin`, `admin`, `scanner`, `asset_viewer`, `dashboard_viewer`. They
stack, and most IT accounts hold several.

`asset_viewer` alone is genuinely view only: the register renders with no Scan,
no Add, no inline editing, no Verify, no Clone, and the USB scanner is inert.
The database refuses those writes independently of the UI. This is the default
for a new invite.

Reading `assets`, `asset_history` and `asset_events` requires at least one
active role. An account with no roles, or one switched to inactive in Admin,
reads nothing at all, including through the API.

### Register

Loaded in one query through `listAssetsDetailed()` in `js/supabase-client.js`,
which enriches each row with book value, depreciation status, useful life, age
and warranty. Filtering, sorting and paging happen in the browser over that
one fetch, so the table stays responsive.

The detail card offers, for writers: inline edit on any field, Scan again,
Clone (prefills the add form and suggests the next free tag), Verify, an image
upload, and Delete for admins. For everyone: History and Events.

### Scanning

Matches **asset tag first, then serial**, case-insensitively. Tags win because
some assets currently carry a placeholder tag in the serial field, and the tag
is what is physically on the label.

- **Camera** through `html5-qrcode`.
- **Walk mode** keeps the camera open for stock takes: hit and miss counters,
  1.5 second dedup of a barcode sitting in frame, flash, beep and vibrate.
- **USB wedge** works anywhere on the page. Fast keystroke bursts ending in
  Enter are classified as a scan, unless a field has focus.

A hit stamps `last_verified` and `last_verified_by`. A miss offers to add the
device with the scanned code prefilled.

### Adding assets

Tag, serial and department are required, plus either a price or the "estimate
pending" flag; database constraints back all of that up. Tags are typed, never
auto-generated, though Clone and the scan-miss flow suggest the next free
`XL-N`. A bundled option creates a tower plus components in one submit,
splitting the total price across them.

For bulk work, `scripts/add-cameras.mjs` is the worked example: it validates
the batch, refuses duplicates, allocates tags and item ids the same way the app
does, and inserts in chunks so the SharePoint mirror is not flooded.

### Events and history

Two separate records against an asset:

- **History** is automatic: every field change, who and when, from a database
  trigger.
- **Events** are entered by hand: issues, repairs, maintenance, transfers and
  notes, each with an optional cost. Issues can be left open and closed later.
  Writers see **+ Log event**; read-only roles see the list.

### Dashboard

Computed in the browser from the same enriched rows, so there is no server
round trip and no second implementation of the numbers. Depreciation is
straight line with no salvage value, prorated continuously. Useful life comes
from the asset type, editable in Admin, falling back to a built-in table.

The depreciation CSV reconciles against the dashboard: cost minus accumulated
equals the closing book value on every row.

### Data and sync

Supabase holds `assets`, `asset_history`, `asset_events`, `app_choices`,
`profiles`, `user_roles`, `sharepoint_sync`, the `choice_usage` view and the
`asset-images` bucket.

Every write queues one row in `sharepoint_sync` and fires an immediate call to
the worker, with a 5 minute cron sweep as backstop. Rows stop retrying after 5
attempts and appear as failed in Admin, where `requeue_failed_sync_rows()`
brings them back. The mirror is one way; nothing typed in SharePoint returns.

### What it deliberately does not do

- No writes from SharePoint back into the register.
- No separate barcode column. The printed label encodes the tag or serial.
- No offline mode. Earlier versions cached and queued writes; that was retired
  with the move to Supabase, and the app now expects a connection.
- No signed URLs for asset images. Public read is intentional so `<img>` works
  without an auth header.

---

*Functionality only. Decisions and their reasons live in `docs/decisions/`,
current operational state in `IT_Manager_Handoff.md`.*
