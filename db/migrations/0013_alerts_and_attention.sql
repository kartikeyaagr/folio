-- What interrupts you, and what waits.
--
-- Severity is not decoration: it is the routing. An auditor resignation should reach all three of
-- you regardless of who covers the name; a board-meeting outcome should not reach anybody at 11pm.
-- Getting that wrong in the loud direction is worse than getting it wrong in the quiet one,
-- because treating every promoter sale as an emergency is how a stream stops being read at all.

-- ------------------------------------------------------------------------------------------------
-- Rules
-- ------------------------------------------------------------------------------------------------

CREATE TABLE alert_rules (
    key        text        PRIMARY KEY,
    label      text        NOT NULL,
    kind       text        NOT NULL,
    severity   text        NOT NULL,
    -- For filing_category: case-insensitive patterns matched against the announcement's category.
    -- Data rather than code, so a category NSE renames is an UPDATE and not a deploy.
    patterns   text[]      NOT NULL DEFAULT '{}',
    config     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- A rule may be global or scoped to one name; the latter is how a per-company threshold works.
    company_id text        REFERENCES companies (id),
    active     boolean     NOT NULL DEFAULT true,

    CONSTRAINT alert_rules_kind_check
        CHECK (kind IN ('filing_category', 'price_move', 'missing_filing')),
    CONSTRAINT alert_rules_severity_check
        CHECK (severity IN ('critical', 'high', 'normal', 'low'))
);

-- ------------------------------------------------------------------------------------------------
-- Alerts
-- ------------------------------------------------------------------------------------------------

CREATE TABLE alerts (
    id          text        PRIMARY KEY,
    rule_key    text        NOT NULL REFERENCES alert_rules (key),
    company_id  text        REFERENCES companies (id),
    severity    text        NOT NULL,
    title       text        NOT NULL,
    detail      text,
    -- What caused it. Deduplication is on this, so re-evaluating the same window raises nothing
    -- twice and the evaluator needs no memory of what it last looked at.
    subject_ref text        NOT NULL,
    raised_at   timestamptz NOT NULL DEFAULT now(),

    acknowledged_at timestamptz,
    acknowledged_by text    REFERENCES users (id),
    snoozed_until   timestamptz,

    CONSTRAINT alerts_severity_check CHECK (severity IN ('critical', 'high', 'normal', 'low')),
    CONSTRAINT alerts_unique_subject UNIQUE (rule_key, subject_ref)
);

CREATE INDEX alerts_open_idx ON alerts (severity, raised_at DESC)
    WHERE acknowledged_at IS NULL;
CREATE INDEX alerts_company_idx ON alerts (company_id, raised_at DESC);

-- ------------------------------------------------------------------------------------------------
-- Reminders
-- ------------------------------------------------------------------------------------------------

-- Set to a date rather than a minute, which is why the delivering job runs hourly: this is about
-- not making somebody wait until tomorrow for something they asked to see today.
CREATE TABLE reminders (
    id          text        PRIMARY KEY,
    body        text        NOT NULL,
    due_on      date        NOT NULL,
    company_id  text        REFERENCES companies (id),
    -- null, 'weekly', 'monthly', 'quarterly'. A repeating reminder is rescheduled on completion,
    -- never duplicated, so there is only ever one live instance of it.
    repeats     text,
    created_by  text        NOT NULL REFERENCES users (id),
    assigned_to text        REFERENCES users (id),
    completed_at timestamptz,
    delivered_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reminders_repeats_check
        CHECK (repeats IS NULL OR repeats IN ('weekly', 'monthly', 'quarterly'))
);

CREATE INDEX reminders_due_idx ON reminders (due_on) WHERE completed_at IS NULL;

-- ------------------------------------------------------------------------------------------------
-- The outbox
-- ------------------------------------------------------------------------------------------------

-- Transactional: a notification is queued in the same commit as the thing it is about, so there is
-- no state where the alert exists and nobody was ever going to be told, or the reverse.
CREATE TABLE notification_outbox (
    id          text        PRIMARY KEY,
    kind        text        NOT NULL,
    recipient   text        NOT NULL REFERENCES users (id),
    subject     text        NOT NULL,
    body        text        NOT NULL,
    alert_id    text        REFERENCES alerts (id),
    reminder_id text        REFERENCES reminders (id),

    queued_at   timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz,
    attempts    integer     NOT NULL DEFAULT 0,
    last_error  text,

    CONSTRAINT notification_outbox_kind_check
        CHECK (kind IN ('alert', 'reminder', 'digest', 'agent_draft', 'unit_failure'))
);

CREATE INDEX notification_outbox_pending_idx ON notification_outbox (queued_at)
    WHERE sent_at IS NULL;

-- ------------------------------------------------------------------------------------------------
-- Calendar
-- ------------------------------------------------------------------------------------------------

CREATE TABLE calendar_events (
    id          text        PRIMARY KEY,
    company_id  text        REFERENCES companies (id),
    kind        text        NOT NULL,
    title       text        NOT NULL,
    on_date     date        NOT NULL,
    source      text        NOT NULL DEFAULT 'nse',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX calendar_events_date_idx ON calendar_events (on_date);

-- ------------------------------------------------------------------------------------------------
-- Trisula's severity calibration
-- ------------------------------------------------------------------------------------------------
--
-- Carried from v2, where each of these was argued rather than guessed. The reasoning is kept
-- because it is the part that will be re-litigated in six months.

INSERT INTO alert_rules (key, label, kind, severity, patterns) VALUES
-- The loudest signal a smallcap gives. Everyone, always.
('auditor_change', 'Auditor change or resignation', 'filing_category', 'critical',
 ARRAY['auditor', 'change in auditors', 'resignation of auditor']),
-- Invocation means the lender already sold. By the time you read it, it has happened.
('promoter_pledge', 'Promoter pledge or invocation', 'filing_category', 'critical',
 ARRAY['pledge', 'encumbrance', 'invocation']),
-- Agencies see the bank limits months before anyone else does.
('rating_action', 'Credit rating action', 'filing_category', 'high',
 ARRAY['credit rating', 'rating']),
-- They sell for personal reasons too, which is why this is high and not critical: treating every
-- sale as an emergency is how a stream stops being read.
('insider_selling', 'Promoter or director dealing', 'filing_category', 'high',
 ARRAY['insider trading', 'acquisition of shares', 'disposal of shares', 'sast']),
-- Changes what you can actually do with the position.
('surveillance', 'Exchange surveillance action', 'filing_category', 'high',
 ARRAY['surveillance', 'gsm', 'asm', 'suspension']),
('kmp_resignation', 'Director or KMP resignation', 'filing_category', 'high',
 ARRAY['resignation of director', 'resignation of kmp', 'cessation']),
('fund_raising', 'Fund raising or capital structure', 'filing_category', 'normal',
 ARRAY['fund raising', 'preferential issue', 'rights issue', 'qip', 'allotment']),
-- Routine by volume, occasionally not. Low so it batches rather than interrupts.
('board_outcome', 'Board meeting outcome', 'filing_category', 'low',
 ARRAY['outcome of board meeting', 'board meeting outcome']),
-- Global default. A per-company rule can override it, because a 10% day means something different
-- for an illiquid SME than for a mainboard name.
('price_move', 'Sharp price move', 'price_move', 'high', ARRAY[]::text[]);

UPDATE alert_rules SET config = '{"percent": 10}'::jsonb WHERE key = 'price_move';

-- ------------------------------------------------------------------------------------------------

SELECT attach_audit('alert_rules');
SELECT attach_audit('alerts');
SELECT attach_audit('reminders');
SELECT attach_audit('notification_outbox');
SELECT attach_audit('calendar_events');
