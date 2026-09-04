# ADR-004: Reading the register requires an active role

## Status
Accepted, live 2026-09-04 (`0029_read_requires_role.sql`)

## Date
2026-09-04

## Context

`0001_initial_schema.sql` shipped the register with:

```sql
create policy "authenticated read assets"
  on public.assets for select to authenticated using (true);
```

`asset_history` (`0014`) and `asset_events` (`0017`) followed the same shape.
The intent at the time was reasonable: everyone who signs in is staff, and the
page gates decide what each person sees.

Two things made that untrue in practice.

1. **The page gate is not a boundary.** `/assets` checks roles in JavaScript,
   but the data sits behind PostgREST on the same publishable key. Any signed
   in account could fetch every asset, purchase price, serial and employee name
   with a single HTTP request, whatever the UI showed them. A
   `dashboard_viewer` exec, or an account invited but not yet assigned a role,
   had the same read access as IT.

2. **Deactivation did nothing to data access.** `/admin` has an Active toggle,
   and `has_role()` already checks `profiles.active`, so a deactivated user
   lost their *write* access. Reads were governed by `using (true)`, which
   does not look at the profile at all. Switching someone off removed their
   screens and left their API access intact.

The estate also now holds financially sensitive material: purchase prices on
228 assets, `asset_history` recording old and new prices, and `asset_events`
carrying repair costs.

## Decision

Reading `assets`, `asset_history` and `asset_events` requires **at least one
active role**:

```sql
create or replace function public.has_app_role() returns boolean ... as $$
  select exists (
    select 1 from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.user_id = auth.uid() and p.active
  );
$$;
```

The predicate deliberately tests "holds any active role" rather than listing
role names. A role added later is covered without another migration, and there
is one place to change if the rule ever tightens further.

`app_choices` stays readable by any authenticated user. It is dropdown
vocabulary with no sensitive content, and the sign-in flow reads it before
roles resolve.

## Consequences

- Deactivating an account in `/admin` is now a real revocation, not a UI hide.
  This is the behaviour an admin already assumed they were getting.
- An invited account with no roles yet sees an empty register rather than the
  whole estate. `/admin` assigns roles at invite time, so the window is small,
  but the failure mode is now safe rather than open.
- `dashboard_viewer` still reads `assets`, because `/dashboard` computes every
  KPI in the browser from `listAssetsDetailed()`. Tightening that further would
  mean a server-side aggregate endpoint, which is a larger change for a
  smaller gain.
- Service role paths are unaffected: the sync worker and the admin API bypass
  RLS entirely.

## Verification

Every real account was simulated against the new predicate before applying,
and again afterwards, inside rolled-back transactions with each user's JWT
claims. All six kept full access. An account with no roles dropped to 0
assets, 0 history rows and 0 events. A deactivated admin dropped to 0 as well,
which was the point.

## Alternatives considered

- **Column-level restriction** (hide price and employee, show the rest to
  everyone). More surgical, but needs a view plus a second read path in the
  client, and the sensitive columns are exactly the ones the dashboard needs.
- **Leave it.** Defensible while every account is trusted staff, but the app
  has an invite flow and a personal Gmail account among its users, so "every
  signed-in account is trusted" is an assumption rather than a control.
