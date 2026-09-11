-- A correction can reach the inside of a draft, and the measurement knows when that started.
--
-- `/review` could correct only top-level string fields. Two agents have none worth correcting:
-- a news brief's judgement lives at `by_company[0].why_it_matters` and a forensic verdict at
-- `answers[3].verdict`, and `components/Brief.tsx` rendered a brief with no inputs at all. So both
-- scored ~0 however wrong they were, could raise no distilled rule, and contributed nothing to the
-- loop `v4.md §7` stakes on that number. This migration is the database's half of closing that.
--
-- ### `ai_drafts.edits` is now keyed by path, not by field name
--
-- `headline` for a flat field, `by_company[0].why_it_matters` for one three levels down. The blob
-- stays FLAT — one object, one key per changed position — because three readers depend on it being
-- flat: `rules.ts` reads a correction back with a single-arrow `d.edits -> o.field`, and
-- `learning.ts` and `distil.ts` unpack it with `jsonb_object_keys` and `jsonb_each`. Nesting it to
-- mirror the content would break all three and none of them would raise.
--
-- Array steps are bracketed and object steps dotted, so that a position can be collapsed without
-- ever touching a key. `0050` already argued this hazard one level up — *"a separator a key can
-- contain is a separator that can collide two different fields into one candidate"*.

-- ------------------------------------------------------------------------------------------------
-- 1. What a rule is written about
-- ------------------------------------------------------------------------------------------------

-- Three corrections to the third company in three different briefs are three corrections to the
-- same THING. Grouped by their literal paths they are three patterns of one and nothing is ever
-- learned, so distillation groups by the path with its positions removed.
--
-- In SQL rather than in TypeScript, and read from here by both callers, because `fieldHotspots`
-- groups in the query and `distil` groups in code: two implementations of one rule, drifting
-- silently, would show a climbing hotspot on /agents with no candidate behind it on /rules, which
-- reads as "nobody has distilled yet".
CREATE FUNCTION edit_field(path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT regexp_replace(path, '\[\d+\]', '[]', 'g') $$;

COMMENT ON FUNCTION edit_field(text) IS
    'A path with its array positions collapsed: by_company[2].why_it_matters becomes '
    'by_company[].why_it_matters. What a prompt rule is written about, as opposed to where one '
    'correction happened. Mirrored by shape() in lib/agents/paths.ts, asserted equal in tests.';

-- ------------------------------------------------------------------------------------------------
-- 2. A distance is a number between nothing and everything
-- ------------------------------------------------------------------------------------------------

-- `draftDistance` averages, and an average needs something to average over. A draft field that is
-- an empty list has no positions inside it — `nothing_to_report: []` is in the one real brief in
-- this tree, and `guidance_changes` is empty whenever there was no prior call — so the arithmetic
-- has a 0/0 in it unless the code is careful, and it is.
--
-- This is the same property as a schema fact rather than a habit, because the failure has no
-- symptom: `'NaN'::numeric(4,3)` is accepted by this column, `NaN > 0` is TRUE in SQL and false in
-- JavaScript. `/agents` would count an untouched draft as edited and render NaN as the agent's
-- weekly mean, while the exemplar written in the same transaction called it accepted.
ALTER TABLE ai_drafts
    ADD CONSTRAINT ai_drafts_edit_distance_range
    CHECK (edit_distance IS NULL OR (edit_distance >= 0 AND edit_distance <= 1));

-- ------------------------------------------------------------------------------------------------
-- 3. Where the series breaks
-- ------------------------------------------------------------------------------------------------

-- **The instrument changed, and a measurement across a change of instrument is not a measurement.**
--
-- `docs/plans/2026-09-11-v4-learning-retrieval.md` carries a dated commitment: by 11-Dec-2026,
-- compare mean edit distance for the four learning agents against the four weeks before retrieval
-- was switched on, and if it has not fallen, set `learning = false`. For `news-brief` and
-- `forensics-review` the baseline half of that comparison is structurally zero — nothing on the
-- review screen could correct either of them — so the day they become correctable the measured mean
-- can only rise, and the condition would switch learning off for precisely the two agents this work
-- exists to serve.
--
-- So the rows say which instrument measured them. Every draft already decided is stamped false;
-- anything still pending will be decided on the new screen and keeps the default. `weeklyDistance`
-- groups on this, so /agents renders the break rather than averaging across it.
--
-- The condition itself is amended in the same commit as this migration, not left as an intention:
-- for those two agents the four-week baseline restarts here. For `concall-insights` and
-- `desk-analyst` it stands unchanged, because their correctable surface did not move.
ALTER TABLE ai_drafts ADD COLUMN nested_editable boolean NOT NULL DEFAULT true;

UPDATE ai_drafts SET nested_editable = false WHERE decided_at IS NOT NULL;

COMMENT ON COLUMN ai_drafts.nested_editable IS
    'Whether the review screen could reach inside this draft when it was decided. False for every '
    'draft decided before 0051. A mean taken across both is a mean of two different measurements.';

-- ------------------------------------------------------------------------------------------------
-- 4. Proving both halves
-- ------------------------------------------------------------------------------------------------

DO $$
DECLARE a_draft text := (SELECT id FROM ai_drafts LIMIT 1);
BEGIN
    IF edit_field('by_company[12].what_happened[0]') <> 'by_company[].what_happened[]' THEN
        RAISE EXCEPTION 'edit_field does not collapse positions';
    END IF;
    -- An object key that reads like a position is not one. This is the whole reason paths bracket
    -- their indices instead of dotting them.
    IF edit_field('figures.2024') <> 'figures.2024' THEN
        RAISE EXCEPTION 'edit_field collapsed an object key';
    END IF;
    IF edit_field('headline') <> 'headline' THEN
        RAISE EXCEPTION 'edit_field is not identity on a flat field';
    END IF;

    -- The constraint above is the whole reason a NaN cannot be stored, and a constraint nobody has
    -- seen fire is a constraint nobody knows is there. Rolls back with its subtransaction.
    IF a_draft IS NOT NULL THEN
        BEGIN
            UPDATE ai_drafts SET edit_distance = 'NaN'::numeric WHERE id = a_draft;
            RAISE EXCEPTION 'a NaN reached edit_distance';
        EXCEPTION WHEN check_violation THEN NULL;
        END;
    END IF;
END $$;
