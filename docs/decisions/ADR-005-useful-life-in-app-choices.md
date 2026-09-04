# ADR-005: Useful life belongs to the asset type, in the database

## Status
Accepted, live 2026-09-04 (`0027_choice_useful_life.sql`)

## Date
2026-09-04

## Context

Depreciation needs a useful life per asset. `enrichAsset()` in
`js/supabase-client.js` resolved it from a hardcoded map:

```js
const USEFUL_LIFE_BY_TYPE = { Laptop: 3, CPU: 4, Monitor: 5, ... Other: 3 };
```

Asset types themselves had already been made admin-managed: `/admin` writes to
`app_choices`, so IT can add "Projector" without a developer. But the two
halves lived in different places, and a type present in one and absent from the
other failed silently:

```js
const type = typeRaw && USEFUL_LIFE_BY_TYPE[typeRaw] ? typeRaw : "Other";
const usefulLife = ... USEFUL_LIFE_BY_TYPE[type] || 3;
```

An admin-added type fell through to `Other`, which is **3 years**. Nothing on
screen said so. The register showed a useful life and a book value that looked
authoritative.

This was not hypothetical. `Camera` had been added to `app_choices` and was
missing from the map. Registering 71 cameras at KES 30,400 each would have
depreciated them at KES 10,133/yr instead of 6,080: about KES 288,000/yr of
overstated depreciation across the batch, from a dropdown entry and a
JavaScript object being out of step.

## Decision

Useful life moves next to the choice it belongs to:

```sql
alter table public.app_choices add column useful_life int;
-- 1..50, and only on category = 'asset_type'
```

`/admin` renders a years box beside each asset type, saving on change.
`listAssetsDetailed()` loads the map once per page load and `enrichAsset()`
prefers it. Resolution order:

1. `extra.useful_life` on the individual asset
2. `app_choices.useful_life` for its type
3. `USEFUL_LIFE_BY_TYPE`
4. 3 years

The column is **nullable** and the JS map stays. A type with no value set
behaves exactly as before, so the migration changes no existing number. The
seed copied the map into the table so both agree from day one.

## Consequences

- Adding an asset type and giving it a depreciation life is now entirely
  self-service. No code change, no deploy, no developer.
- Finance-visible numbers are configurable by IT, which cuts both ways: the
  years box is an input that changes book value across every asset of that
  type. It sits behind the admin role, and the delete confirmation warns when
  removing a type would discard its life.
- The JS map is now a fallback rather than the authority. It should not be
  extended for new types; set the value in Admin instead.
- One extra query per page load, run in parallel with the asset fetch.

## Alternatives considered

- **Keep the map, add Camera to it.** Fixes one type, leaves the trap for the
  next one. The failure is silent, which is what makes it worth designing out.
- **Per-asset `extra.useful_life` only.** Already supported, but it is a
  per-row override with no UI, so it would mean setting the same number on
  every asset of a type and re-setting it on every new one.
- **A dedicated `asset_types` table** with life, category and depreciation
  method. Cleaner in the abstract, but it duplicates `app_choices`, which is
  already the admin-managed vocabulary, and would need a migration of existing
  values plus a second admin screen.
