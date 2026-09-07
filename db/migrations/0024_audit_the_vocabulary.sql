-- The vocabulary is edited by people, so it is audited like everything else people edit.
--
-- Caught by the schema test that asserts audit coverage rather than trusting it. A term quietly
-- added or removed changes which stories reach the desk, and "why did we stop seeing sugar-mill
-- news" should be answerable.

SELECT attach_audit('sector_terms');
