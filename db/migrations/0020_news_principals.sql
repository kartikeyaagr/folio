-- The two principals the news pipeline writes as.
--
-- Kept apart on purpose: the poller copies other people's headlines, and the gate decides which of
-- them the desk is shown. When somebody asks later why a story appeared, the audit log should say
-- which of those two put it there.

INSERT INTO actors (id, kind, label) VALUES
  ('system:news', 'service', 'News poller'),
  ('system:news-gate', 'service', 'News mechanism gate');
