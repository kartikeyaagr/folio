-- A restatement needs both rows to exist before either is valid.
--
-- The old row must point at the new one (superseded_by), and the new row cannot exist while the
-- old one is still live, because the partial unique index allows one un-superseded row per period.
-- So the two writes are circular: neither is legal on its own, and both are legal together.
--
-- Deferring the foreign key to commit time is exactly what that shape calls for. The alternative —
-- inserting with a placeholder and patching it afterwards — leaves a window where the table says
-- something untrue, which is the thing this table exists not to do.
ALTER TABLE fundamentals
    DROP CONSTRAINT fundamentals_superseded_by_fkey,
    ADD CONSTRAINT fundamentals_superseded_by_fkey
        FOREIGN KEY (superseded_by) REFERENCES fundamentals (id)
        DEFERRABLE INITIALLY DEFERRED;
