-- The three agents that write for a reader rather than for a checker.
--
-- All three run at `xhigh` while agents 1 and 7 run at `high`, and the reason is the safety net
-- rather than the difficulty: those two have deterministic checks under them — a filed figure, a
-- structural rule — so a wrong answer is caught before a person sees it. These three have nothing
-- under them but the reviewer, so the effort dial is where the care has to go.
--
-- Data scopes are narrow and enforced: `assertInScope` throws when a handler reads a table its row
-- does not name, so a scope is a fact rather than a comment.

INSERT INTO agents (key, label, purpose, trigger, model, effort, data_scope, notify_on_draft) VALUES

  ('concall-insights', 'Concall insights',
   'Summarise an earnings call and say how management''s guidance has changed since the last one. ' ||
   'The delta is the product: a summary of one call restates what was said, and what a reader ' ||
   'needs is what is different. Where the prior call is not held, say the comparison is ' ||
   'unavailable rather than describing the current call as a change. Quote management''s own ' ||
   'words for anything you characterise as a commitment or a target.',
   'event', 'claude-opus-5', 'xhigh',
   ARRAY['companies', 'documents', 'document_versions', 'fundamentals'], true),

  ('company-dossier', 'Analyse a company from scratch',
   'Assemble everything the system holds on one company into a dossier a reader can act on: what ' ||
   'the business is, what the numbers have done, what the filings and disclosures show, and what ' ||
   'is unresolved. State plainly where the record is thin — a dossier that reads complete on a ' ||
   'company nobody has researched is worse than a short one. This agent does NOT work the ' ||
   'forensic checklist; that is a separate agent, and twelve careful checks folded into a section ' ||
   'become a paragraph.',
   'prompt', 'claude-opus-5', 'xhigh',
   ARRAY['companies', 'filings', 'fundamentals', 'documents', 'document_versions',
         'insider_transactions', 'shareholding_patterns', 'prices', 'holdings'], true),

  ('news-brief', 'News brief and exchange updates',
   'Brief the desk on what has happened to the names it follows: exchange filings first, then ' ||
   'confirmed news, then what is scheduled. Prompted rather than scheduled — a brief nobody asked ' ||
   'for at 06:30 is read once and then never again. Cover exchange filings even when there is no ' ||
   'press: for a company nobody writes about, the filings are the news. Say when a name has had ' ||
   'nothing rather than filling the space.',
   'prompt', 'claude-opus-5', 'xhigh',
   ARRAY['companies', 'filings', 'news_items', 'news_matches', 'calendar_events', 'alerts'], true);
