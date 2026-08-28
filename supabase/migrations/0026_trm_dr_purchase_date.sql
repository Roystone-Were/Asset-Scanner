-- Backfill purchase_date for all assets at TRM Dr (acquired 2026-07-02).
-- purchase_date lives in extra JSONB, same jsonb_set pattern as 0012/0024.
-- Confirmed against live data 2026-08-28: 9 assets at TRM Dr, all with a
-- null purchase_date beforehand (XL-40, XL-5, XL-55..61).

update public.assets set extra = jsonb_set(coalesce(extra,'{}'::jsonb),'{purchase_date}','"2026-07-02"')
  where location = 'TRM Dr' and deleted_at is null;
