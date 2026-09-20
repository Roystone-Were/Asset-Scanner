-- ============================================================================
-- 0037: Representation hygiene (found by the 2026-09-20 audit).
--
-- 1. extra.purchase_price was stored inconsistently: the add sheet writes the
--    text input straight through (jsonb string) while the inline editor sends
--    Number() (jsonb number). Live split was 92 strings / 42 numbers / 75 null
--    / 15 absent. Both parse fine today (enrichAsset string-replaces), but
--    jsonb_typeof, <@ containment, ORDER BY and any future SQL aggregate see
--    two different types for the same concept. Every one of the 92 strings is
--    plain digits (verified before writing this file), so the conversion
--    cannot lose a value; anything non-numeric would be left alone by the
--    regex guard.
--
-- 2. asset_events rows for moves were logged resolved=false before
--    addAssetEvent learned that only issues stay open (js/supabase-client.js:
--    "only an issue can stay open; everything else is a completed
--    happening"). 27 such rows from 24-27 Aug 2026 are still open and sit in
--    the IT open-issue view forever. Transfers, repairs, maintenance and notes
--    are completed happenings, so close them.
--
-- Both statements fire the assets outbox and audit triggers by design, so the
-- SharePoint mirror and asset_history stay consistent with the register (92
-- extra-only patches on the mirror, no field changes).
-- ============================================================================

update public.assets
   set extra = jsonb_set(extra, '{purchase_price}', to_jsonb((extra ->> 'purchase_price')::numeric))
 where deleted_at is null
   and jsonb_typeof(extra -> 'purchase_price') = 'string'
   and (extra ->> 'purchase_price') ~ '^[0-9]+(\.[0-9]+)?$';

update public.asset_events
   set resolved = true
 where event_type <> 'issue'
   and resolved = false;
