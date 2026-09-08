-- A followed name fills itself in.
--
-- Adding a company attaches the filings already stored for its symbol — whatever the fourteen-day
-- announcement window happened to catch — and nothing else. Its history, its documents, its
-- results, its shareholding and its price series all needed a job run by hand, and the
-- confirmation toast said so, which is a poor substitute for doing it.
--
-- The work cannot happen inside the request. It is minutes of network calls against three
-- endpoints, and a server action that took four minutes would time out having done part of it,
-- with no record of which part. So this is a queue, in the shape the rest of the system uses:
-- `backfilled_at IS NULL` means "has no backfill yet", and the job asks that rather than asking
-- what changed since it last looked. A crash halfway leaves the row unclaimed and the next run
-- picks it up.
--
-- `backfill_error` holds the last failure rather than a status enum: a name that failed is still a
-- name with no backfill, so it stays in the queue by the same predicate, and the text says why the
-- last attempt did not finish.

ALTER TABLE companies ADD COLUMN backfilled_at timestamptz;
ALTER TABLE companies ADD COLUMN backfill_started_at timestamptz;
ALTER TABLE companies ADD COLUMN backfill_error text;

-- The queue: what has no backfill yet, oldest ask first.
CREATE INDEX companies_backfill_queue ON companies (created_at)
  WHERE backfilled_at IS NULL;

COMMENT ON COLUMN companies.backfilled_at IS
  'When the whole history was fetched. NULL means the backfill job still owes this name.';

-- The two companies that predate this were backfilled by hand today, so they are not queued for a
-- second pass. TCL was added through the UI and never was, so it stays NULL and the job will take
-- it — which is the first real exercise of the queue.
UPDATE companies SET backfilled_at = now() WHERE symbol IN ('PRAJIND', 'AERON');

-- Somebody has to be told when it finishes; `agent 4` drains the outbox to whatever relay exists.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK (kind = ANY (ARRAY['alert', 'reminder', 'digest', 'agent_draft', 'unit_failure', 'backfill']));

-- Who asked for the name, so the finished notice goes to them rather than to everybody. Null for
-- the two seeded by hand, and for any company created before this column existed.
ALTER TABLE companies ADD COLUMN added_by text REFERENCES users(id);
