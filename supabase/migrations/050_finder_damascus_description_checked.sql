-- Whether a Damascus row's full eBay description (not just the search snippet) has been read. A
-- Damascus listing is never qualified on the snippet alone: "choose an option" wording (the price is
-- for one knife, not the set in the title) and accessory-inflated piece counts usually only appear in
-- the full description. See verifyDamascusDescription in lib/finder-service.ts.
alter table public.finder_items add column if not exists damascus_description_checked boolean not null default false;
