-- One envelope a morning, instead of one mail per event.
--
-- At the fund's instruction, 17-Sep-2026: everybody signed in gets a daily update at their company
-- address, and nothing else. Agent 4 used to call `drainOutbox`, which sends one mail per queued
-- `notification_outbox` row — three alerts and two reminders on a busy Tuesday was five mails.
-- It now calls `sendDigests`, which gathers every unsent row for a person into one, sends it after
-- 07:00 IST, and marks them sent together.
--
-- **Nothing about the producers changed, and that is the design.** `lib/alerts.ts`,
-- `lib/reminders.ts` and `jobs/backfill-company.ts` still write a row per person per event, and the
-- outbox is still the record of what the system decided to tell somebody. `alert_id` and
-- `reminder_id` are what make that queueing idempotent; a digest that gathered from the source
-- tables instead would have had to re-derive that and would have drifted from it.
--
-- The `kind` check constraint already allowed `'digest'` — `0013` wrote it in — so no schema change
-- is needed for the envelope itself. The rows keep their own kinds; the digest is how they leave.

-- Five minutes was right for "send each mail as it is queued". For one envelope a morning it is 288
-- runs a day against a gate that opens once, and `/agents` reads the registry's run counts — an
-- agent with 288 runs and one action a day makes that column say nothing. Hourly still puts the
-- digest out within an hour of 07:00, which is the only latency that matters now.
UPDATE agents SET min_interval_minutes = 60 WHERE key = 'email-workflow';

COMMENT ON TABLE notification_outbox IS
  'What the system decided to tell somebody. One row per person per event, written by the '
  'producers; delivered as one daily digest per person by lib/digest.ts. sent_at is set on every '
  'row that went in an envelope, so "a digest went today" is derivable and needs no column.';

DO $$
BEGIN
  IF (SELECT min_interval_minutes FROM agents WHERE key = 'email-workflow') <> 60 THEN
    RAISE EXCEPTION 'email-workflow did not take its new interval';
  END IF;
  -- The reminders agent is deliberately untouched. It queues into the same outbox and its work now
  -- rides the digest; changing its hour would only decide twice when a reminder is delivered.
  IF (SELECT min_interval_minutes FROM agents WHERE key = 'reminders') <> 60 THEN
    RAISE EXCEPTION 'reminders was expected to stay hourly';
  END IF;
END $$;
