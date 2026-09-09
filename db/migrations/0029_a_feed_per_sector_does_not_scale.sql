-- The sector-tagged trade press comes out.
--
-- A tagged source only ever matches companies in its own sector: the matcher drops a candidate when
-- the source declares a sector and the company's is different. That makes the feed list a function
-- of the book. Every name added in a sector nothing covers needs a trade title found, fetched,
-- verified and seeded before that company sees a single vocabulary match — and nothing fails when
-- it is missing. A sector with no title behaves exactly like a sector with nothing written about it.
--
-- What the record says about the cost of removing them: of the eight matches decided so far,
-- confirmed and rejected alike, every one came from an untagged general-press feed — et-energy,
-- bl-agri, bl-economy, hindu-business. The 21 tagged titles produced none.
--
-- The `sector_term` tier itself is not being retired. An untagged source passes the sector check, so
-- the 26 general-press feeds already carry that tier and go on carrying it. What is lost is the
-- trade press's own contribution to it, which 0018 argued was where an uncovered SME's information
-- lives. That argument still stands; it lost to the maintenance burden, not to a measurement.
--
-- Deactivated rather than deleted, for the reason `pib` is a row rather than an absence: the reason
-- survives where the next person will look for it, the 389 items already fetched keep their
-- referential integrity, and the dismissal record that would justify revisiting this stays readable.
-- `active` is now the whole of the question — the matcher tests it too, so an inactive source
-- contributes nothing, its already-fetched backlog included.
--
-- `market` and the sector check stay in the matcher. Every remaining source is Indian and untagged,
-- so neither fires today; both are what would make a re-activated title behave correctly.

DO $$
DECLARE deactivated int;
BEGIN
  UPDATE news_sources SET active = false WHERE sector IS NOT NULL;

  -- 0019 seeded 21 tagged titles and nothing since has added one. A different number means the seed
  -- has drifted from what this migration was written against, and silently deactivating some other
  -- set is worse than refusing to run.
  GET DIAGNOSTICS deactivated = ROW_COUNT;
  IF deactivated <> 21 THEN
    RAISE EXCEPTION 'expected 21 sector-tagged sources, deactivated %', deactivated;
  END IF;
END $$;
