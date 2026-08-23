-- 0013: backstop constraints — no asset without a tag; price recorded or
-- explicitly flagged as an estimate. Safe to apply only after the
-- backfill (scripts/backfill-quality.mjs --apply) has cleared violators.

alter table public.assets drop constraint if exists assets_tag_required;
alter table public.assets
  add constraint assets_tag_required
  check (coalesce(nullif(asset_tag,''), nullif(title,'')) is not null);

alter table public.assets drop constraint if exists assets_price_or_estimate;
alter table public.assets
  add constraint assets_price_or_estimate
  check (
    coalesce(nullif(extra->>'purchase_price',''), '') <> ''
    or coalesce(extra->>'estimate_pending','') = 'true'
    or (extra->>'estimate_pending')::boolean is true
  );
