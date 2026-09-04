# Xana Asset System: executive briefing

**Date:** 2026-09-04
**Live:** https://xana-assets.vercel.app
**Classification:** Internal
**Supersedes:** `CEO_Executive_Briefing_2026-08-26.md`

---

## 1. Summary

The Xana Asset System is the single source of truth for company assets. IT
scans or searches an asset in `/assets` and the register updates instantly;
the SharePoint list stays as a read-only mirror, kept in step automatically.
Execs open `/dashboard` for portfolio value, depreciation and health from the
same live data.

Since the August briefing the register has grown by 84 assets, the CCTV estate
is now tracked, depreciation is configurable without a developer, and access is
enforced by the database rather than only the screens.

---

## 2. Portfolio snapshot

| Measure | Value |
|---|---|
| **Live assets** | **228** (1 in the recycle bin) |
| **In use** | 224. Available 3, Lost 1 |
| **Top locations** | Syokimau 95, Ruiru 90, TRM Dr 12, Lumumba Dr 12, Katani 11, Githurai 8 |
| **Top types** | Camera 71, Printer 19, CPU 16, Monitor 15, Keyboard 12, Mouse 12 |
| **Purchase value recorded** | **KES 4,588,820** across 138 priced assets |
| **Book value today** | KES 4,134,195 |
| **Annual depreciation** | KES 964,263 |
| **No price recorded** | **90 assets** (112 flagged estimate pending) |
| **Unverified over 90 days** | 32 assets |
| **SharePoint mirror** | 1,178 rows synced, nothing pending or failed |

Depreciation is straight line with no salvage value, prorated daily. Useful
life is set per asset type and is now editable by IT without a code change.

**The number that needs attention:** 90 of 228 assets carry no purchase price.
The KES 4.59M above is therefore roughly 60% of what the company actually
owns. Everything else on this page is sound; that one gap moves every value.

---

## 3. What changed since 26 August

| Change | Why it matters |
|---|---|
| **71 CCTV cameras registered** across all six branches, at KES 30,400 each over 5 years | The CCTV estate was invisible in the register. It now carries KES 2.16M of value and KES 431,680/yr of depreciation |
| **View-only access is real** | Finance and similar staff can read the register, prices and history with no ability to change anything. It is the default for new accounts |
| **Access enforced in the database** | Previously any signed-in account could read every asset, price and employee name through the API. Now a role is required, and deactivating an account genuinely revokes access |
| **Depreciation life is self-service** | Adding an asset type and setting its life takes a minute in Admin. Previously a new type silently depreciated over 3 years until a developer changed the code |
| **Repairs and faults can be logged** | Issues, repairs, maintenance, transfers and notes with costs now attach to an asset, and issues stay open until closed |
| **Depreciation export reconciles** | Cost minus accumulated now equals closing book value on every row, so Finance can tie the sheet to the dashboard |
| **Scanning ambiguity removed** | Some assets carry placeholder tags in the serial field; a scan could open the wrong asset. Tags now take precedence |

---

## 4. Business impact

- **Audit readiness.** Every field change is written to an audit trail with the
  person and timestamp. Every scan records who verified the asset and when.
- **Insurance and finance.** The CCTV estate is now valued and depreciating
  rather than absent from the books.
- **Offboarding.** People view, search a leaver, mark everything returned in
  one action.
- **Access control.** Read access requires an active role. Turning off an
  account in Admin removes its access to data, not just to screens.
- **Maintenance history.** Repair costs accumulate against the asset, which
  informs repair-or-replace decisions.

---

## 5. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **90 assets with no price**, so book value is understated | High | Work list with a blank price column is ready at `backfill/missing-purchase-price-2026-09-04.csv`. 84 of the 90 sit at Syokimau and Ruiru |
| 16 Syokimau assets have no purchase date, so they never depreciate | Medium | Same exercise. Every other branch is now dated |
| 32 assets unverified for over 90 days | Medium | One walk-mode pass per branch. The monthly health check reports the count |
| Duplicate and placeholder serial numbers on about 40 assets | Medium | Scanning prefers tags, so day-to-day use is safe. Real tags are on order |
| No asset photos yet | Low | The feature is live on every asset card; a floor pass would populate it |
| Register still needs a connection | Low | The offline cache was retired with the platform move. Branch Wi-Fi has been reliable |

---

## 6. Costs

Unchanged. Supabase free tier, Vercel hobby, public image bucket well within
limits. No new licences.

---

## 7. Decisions needed

1. **Finance: a date for clearing the 90 missing prices.** This is the single
   highest-value action available and it needs no IT work beyond loading the
   completed sheet.
2. **Schedule a verification sweep** for the 32 assets unverified over 90 days.
3. **Photo backfill**, if visual verification is wanted for high-value kit.

---

## 8. Using it

- **Dashboard:** `/dashboard` for value, depreciation, idle stock, lost assets.
- **Register:** `/assets` to search, open an asset, read its history and events.
- **Admin:** `/admin` for users, roles, dropdown lists and sync health.

*Figures taken live from Supabase on 2026-09-04.*
