-- The generic 'carving set' keyword was disabled in 026_finder_carving_sets_brand_keywords.sql
-- because it was dominated by wood-carving/whittling tool kits (BeaverCraft, Flexcut, etc.).
-- lib/carving-set-finder.ts has since grown text-level defenses specifically for that noise
-- (modernOriginPattern, and especially woodCarvingToolPattern's whittl*/wood-carving/basswood/
-- beavercraft/flexcut/sloyd checks) that apply to every carving-set group, not just the named
-- English brand phrases — re-enabling this broader phrase now recovers real antique-cutlery
-- recall it used to catch, filtered through those same defenses instead of leaking through as
-- false positives the way it did before they existed.
update public.finder_keywords set enabled = true where phrase = 'carving set';
