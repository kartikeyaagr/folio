-- The two agents P5 ships, as rows.
--
-- Registered here rather than declared at their call sites so that "what runs unattended, and over
-- what data" is one query and not a grep. An agent absent from this table cannot be invoked.
--
-- Model routing is quality-first; cost is not a constraint. v2's rule was Sonnet where the answer
-- is checked and Opus where it is not, which was a cost heuristic. With cost off the table the
-- dial is `effort`, and the criterion is the safety net: both of these have one, so both sit at
-- `high` rather than `xhigh`. Agent 7 is deliberately not at `max` — a max-effort pass over a
-- ten-year history can exceed the 30-minute claim lease, and `max` has no eval behind it.

INSERT INTO agents (key, label, purpose, trigger, model, effort, data_scope, notify_on_draft) VALUES
(
  'results-figures',
  'Quarterly results figures',
  'Extract the figures from a results filing and say what moved and why. Report in crore. Where a '
  'figure was not reported, say so rather than estimating it. Your figures are reconciled against '
  'the filed XBRL afterwards: where the two disagree, both readings are shown and neither is '
  'corrected, so a confident wrong number is worse than an admitted gap.',
  'event', 'claude-opus-5', 'high',
  ARRAY['filings', 'fundamentals', 'attachments'],
  true
),
(
  'forensics-review',
  'Forensic review',
  'Work through Trisula''s forensic checklist for a company whose annual results have landed. '
  'Answer each item from the filings and financial history held. Roughly half the checklist asks '
  'about judgement and scuttlebutt that no filing contains; answer those `unanswerable` and say '
  'what would answer them. A verdict of `clear` on something the filings cannot show launders an '
  'absence of evidence into a clean bill of health, and is worse than no answer at all.',
  'event', 'claude-opus-5', 'high',
  ARRAY['companies', 'filings', 'fundamentals', 'attachments',
        'forensics_templates', 'forensics_template_items'],
  true
);
