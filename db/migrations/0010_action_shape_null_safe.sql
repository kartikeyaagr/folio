-- Fix a CHECK constraint that passed the case it existed to reject.
--
-- 0009 wrote:
--
--   CHECK ((kind IN ('bonus','split') AND ratio_from > 0 AND ratio_to > 0 AND ...) OR (...))
--
-- With kind = 'bonus' and ratio_from NULL, `ratio_from > 0` is NULL, so the first branch is NULL,
-- the second is false, and `NULL OR false` is NULL. **A CHECK constraint passes when it evaluates
-- to NULL**, so a bonus with no ratio was accepted — and would then replay as a silent no-op,
-- which is the exact failure the constraint was written to prevent.
--
-- Three-valued logic is the trap. The fix is to test presence explicitly rather than let a
-- comparison against NULL stand in for it.
ALTER TABLE corporate_actions DROP CONSTRAINT corporate_actions_shape_check;
ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_shape_check CHECK (
    CASE kind
        WHEN 'dividend' THEN
            amount_per_share IS NOT NULL
            AND ratio_from IS NULL
            AND ratio_to IS NULL
        ELSE
            ratio_from IS NOT NULL AND ratio_from > 0
            AND ratio_to IS NOT NULL AND ratio_to > 0
            AND amount_per_share IS NULL
    END
);
