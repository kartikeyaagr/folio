-- Agents that run on a cadence rather than on an event.
--
-- v2 registered `email-workflow` and `reminders` as agents and then ran both from their own
-- timers, so neither ever appeared in agent_runs. The registry described work it did not govern.
-- Here the registry is true: these two go through the same queue, claim and failure handling as
-- every other agent, and "what ran, when, and did it fail" is one question with one answer.
--
-- No cron string. A cron string is a second schedule that can disagree with the timer actually
-- installed — v2 had exactly that, a row saying 09:00 daily against a unit running hourly, with
-- nothing reading the row. A minimum interval cannot disagree with anything: the sweep enqueues
-- one run if the last one finished longer ago than this, and the job's own cadence does the rest.
ALTER TABLE agents ADD COLUMN min_interval_minutes integer;

COMMENT ON COLUMN agents.min_interval_minutes IS
    'For trigger = schedule: enqueue at most one run per this many minutes. Null for event and '
    'prompt agents.';

INSERT INTO agents (key, label, purpose, trigger, model, data_scope, min_interval_minutes) VALUES
(
  'email-workflow',
  'Email workflow',
  'Drain the notification outbox: claim, send, mark. No model.',
  'schedule', 'none',
  ARRAY['notification_outbox'],
  5
),
(
  'reminders',
  'Reminders',
  'Deliver reminders that have come due, and reschedule the recurring ones. No model.',
  'schedule', 'none',
  ARRAY['reminders'],
  -- Hourly, not daily. A reminder is set to a date rather than a minute, so this is about not
  -- making somebody wait until tomorrow for something they asked to see today.
  60
);
