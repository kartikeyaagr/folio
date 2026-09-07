-- The agent substrate, and the checklist agent 7 works through.
--
-- An agent is a ROW, not a call site. "What runs unattended, over what data, on which model" is
-- one query rather than a grep, and an agent absent from this table cannot be invoked at all.
--
-- Nothing an agent writes reaches the record without a person accepting it. That gate is the
-- reason this design is safe to point at a model, and it is a security control as much as a
-- quality one: agents read filings and PDFs written by other people, so a crafted document can
-- carry instructions. A human accept is what stands between that and the fund's record.

-- ------------------------------------------------------------------------------------------------
-- The registry
-- ------------------------------------------------------------------------------------------------

CREATE TABLE agents (
    key        text        PRIMARY KEY,
    label      text        NOT NULL,
    purpose    text        NOT NULL,
    -- event: a sweep finds work with no run yet. schedule: a cadence. prompt: a person asks.
    trigger    text        NOT NULL,
    model      text        NOT NULL,
    -- low | medium | high | xhigh | max. The quality dial; spend it where nothing checks the answer.
    effort     text,
    -- Tables this agent may read. Asserted before the model is called, so an agent cannot quietly
    -- widen its own reach.
    data_scope text[]      NOT NULL DEFAULT '{}',
    notify_on_draft boolean NOT NULL DEFAULT false,
    enabled    boolean     NOT NULL DEFAULT true,

    CONSTRAINT agents_trigger_check CHECK (trigger IN ('event', 'schedule', 'prompt'))
);

-- ------------------------------------------------------------------------------------------------
-- Runs
-- ------------------------------------------------------------------------------------------------

CREATE TABLE agent_runs (
    id           text        PRIMARY KEY,
    agent_key    text        NOT NULL REFERENCES agents (key),
    -- What this run is about: a fundamentals row, a company, a filing. The sweep asks "what has no
    -- run yet" by joining on this, which is why it is a plain text key and not a jsonb blob.
    subject_ref  text,
    company_id   text        REFERENCES companies (id),
    request      jsonb       NOT NULL DEFAULT '{}'::jsonb,

    status       text        NOT NULL DEFAULT 'queued',
    attempts     integer     NOT NULL DEFAULT 0,
    -- The claim lease. A run still 'running' past this is assumed dead and re-queued. Effort
    -- levels must stay inside it, or a long job is re-run and double-billed.
    claimed_at   timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),

    started_at   timestamptz,
    finished_at  timestamptz,
    -- One of: refusal, truncated, unparseable, schema_mismatch, error. Named states, never a
    -- generic failure, because each one means a different thing to whoever reads it later.
    failure_kind text,
    error        text,
    draft_id     text,
    requested_by text        REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agent_runs_status_check
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
    CONSTRAINT agent_runs_failure_check
        CHECK (failure_kind IS NULL OR failure_kind IN
               ('refusal', 'truncated', 'unparseable', 'schema_mismatch', 'error'))
);

-- The sweep's question, and the claim's. Partial so the queue index stays small as history grows.
CREATE INDEX agent_runs_queue_idx ON agent_runs (next_attempt_at)
    WHERE status = 'queued';
CREATE INDEX agent_runs_subject_idx ON agent_runs (agent_key, subject_ref);
CREATE INDEX agent_runs_stuck_idx ON agent_runs (claimed_at) WHERE status = 'running';
-- Failed runs are never re-offered by the sweep, so they must be visible somewhere.
CREATE INDEX agent_runs_failed_idx ON agent_runs (finished_at DESC) WHERE status = 'failed';

-- ------------------------------------------------------------------------------------------------
-- Drafts
-- ------------------------------------------------------------------------------------------------

CREATE TABLE ai_drafts (
    id           text        PRIMARY KEY,
    run_id       text        NOT NULL REFERENCES agent_runs (id),
    agent_key    text        NOT NULL REFERENCES agents (key),
    company_id   text        REFERENCES companies (id),

    content      jsonb       NOT NULL,
    -- Where every claim came from. A queue that hides provenance trains people to wave things
    -- through, so this is not optional.
    sources      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- A deterministic check against figures the system already holds, with BOTH readings kept when
    -- they disagree. The model's answer is never silently corrected.
    verification jsonb,

    model        text        NOT NULL,
    input_tokens  integer,
    output_tokens integer,
    -- Computed at write time from a constant in code. v2's Fleet page showed $0.00 because a
    -- pricing table was never seeded; a number that cannot be known must not be displayed.
    cost_usd     numeric(12, 6),

    status       text        NOT NULL DEFAULT 'pending',
    -- What a person changed before accepting, field by field. The distance between what the model
    -- said and what was signed off is the only honest measure of whether it is any good.
    edits        jsonb,
    decided_by   text        REFERENCES users (id),
    decided_at   timestamptz,
    reject_reason text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ai_drafts_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
    -- A rejection without a reason teaches nobody anything, including the next prompt.
    CONSTRAINT ai_drafts_reject_check
        CHECK (status <> 'rejected' OR (reject_reason IS NOT NULL AND reject_reason <> ''))
);

CREATE INDEX ai_drafts_queue_idx ON ai_drafts (created_at DESC) WHERE status = 'pending';
CREATE INDEX ai_drafts_company_idx ON ai_drafts (company_id, created_at DESC);

-- ------------------------------------------------------------------------------------------------
-- The forensic checklist
-- ------------------------------------------------------------------------------------------------

-- Versioned on purpose. Answers point at the version they were answered under, so revising the
-- questions leaves every past checklist still meaning what it meant.
CREATE TABLE forensics_templates (
    version    integer     PRIMARY KEY,
    label      text        NOT NULL,
    active     boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX forensics_templates_one_active ON forensics_templates ((active)) WHERE active;

CREATE TABLE forensics_template_items (
    version  integer NOT NULL REFERENCES forensics_templates (version),
    item     integer NOT NULL,
    section  text    NOT NULL,
    prompt   text    NOT NULL,
    guidance text    NOT NULL,

    PRIMARY KEY (version, item)
);

CREATE TABLE forensics_checklists (
    id           text        PRIMARY KEY,
    company_id   text        NOT NULL REFERENCES companies (id),
    version      integer     NOT NULL REFERENCES forensics_templates (version),
    -- The filing that triggered it, so a checklist can be tied to what it was answering about.
    fundamentals_id text     REFERENCES fundamentals (id),
    drafted_by_agent boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE forensics_answers (
    checklist_id text NOT NULL REFERENCES forensics_checklists (id) ON DELETE CASCADE,
    item         integer NOT NULL,
    -- 'unanswerable' is a first-class verdict, not a gap. Roughly half this checklist asks about
    -- judgement and scuttlebutt that no filing contains, and returning "clear" for one of those is
    -- worse than returning nothing.
    verdict      text NOT NULL,
    note         text,

    PRIMARY KEY (checklist_id, item),
    CONSTRAINT forensics_answers_verdict_check
        CHECK (verdict IN ('clear', 'concern', 'red_flag', 'unanswerable'))
);

-- ------------------------------------------------------------------------------------------------
-- Trisula's checklist, version 1
-- ------------------------------------------------------------------------------------------------

INSERT INTO forensics_templates (version, label, active)
VALUES (1, 'Trisula forensic checklist', true);

INSERT INTO forensics_template_items (version, item, section, prompt, guidance) VALUES
    (1, 1, 'Cash flow conversion', 'Is CFO converting EBITDA over the long run?',
     'Assess CFO as a percentage of EBITDA over five to ten years. Red flag if consistently below 70%, or materially weaker than best-in-class peers. One bad year is a working-capital swing; a decade below 70% is a business that reports profit it does not collect.'),
    (1, 2, 'Working capital', 'What do inventory, receivables and payables say about bargaining power?',
     'Evaluate the efficiency of each and the cash conversion cycle. These reflect where the company sits in its supply chain. Flag persistent deterioration or an abnormal shift in the trend rather than a single period''s level.'),
    (1, 3, 'DuPont analysis', 'Which driver sustains the normalised ROE?',
     'Decompose ROE into net margin x asset turnover x financial leverage, and judge which of the three is carrying it. Margin- and turnover-led returns are preferred to leverage-led ones: leverage raises ROE without improving the business, and reverses hard.'),
    (1, 4, 'Related-party transactions', 'How large is the related-party exposure, and on what terms?',
     'Track related-party advances as a percentage of sales and of net worth. Red flag elevated exposure, thin disclosure, or terms that would not be agreed with an unrelated counterparty.'),
    (1, 5, 'Capital allocation', 'Where has the capital come from, where has it gone, and what did it earn?',
     'Map sources — debt, equity dilution, internal accruals — against uses: capex, M&A, investments, working capital, and returns to shareholders through dividends and buybacks. Judge capital efficiency and look for evidence of value-accretive versus value-destructive deployment.'),
    (1, 6, 'Gearing', 'Can the balance sheet survive a bad year?',
     'Net cash is preferred where feasible, though a nascent business may not manage it. The minimum is a debt-to-equity below 1 and an interest coverage ratio where operating profits service interest comfortably.'),
    (1, 7, 'Governance', 'KMP and directors'' remuneration',
     'Flag pay that is excessive in absolute terms or poorly structured — weakly linked to performance, or linked to metrics management controls directly.'),
    (1, 8, 'Governance', 'Management attrition',
     'Track churn at the top and at middle levels. LinkedIn is the practical source. A finance function turning over is worth more attention than a sales one.'),
    (1, 9, 'Governance', 'Independent directors',
     'Are they useful, or lip service? Look at their other commitments, their relevant expertise, and whether any of them has ever visibly dissented.'),
    (1, 10, 'Governance', 'Culture and reputation',
     'Employee feedback on AmbitionBox and Glassdoor; customer sentiment where the business is consumer-facing or a platform.'),
    (1, 11, 'Governance', 'Management credibility — walk the talk',
     'Assess promises against delivery over several years, the track record on past capital allocation decisions, and what scuttlebutt says.'),
    (1, 12, 'Governance', 'Audit quality',
     'Auditor strength and reputation. Prefer an unqualified opinion. Scrutinise a qualified one. An adverse opinion or a disclaimer is a clear red flag.'),
    (1, 13, 'Governance', 'Contingent liabilities as a percentage of net worth',
     'High levels indicate off-balance-sheet risk, potential hidden leverage, and a possible attempt to understate liabilities. Note: the quarterly XBRL has no element for these, so this one is read from the annual report rather than computed.'),
    (1, 14, 'Governance', 'CWIP to gross block',
     'High levels flag aggressive capitalisation, stalled projects, or inflated asset quality — capital sitting in construction that is not yet earning and may never.');

-- ------------------------------------------------------------------------------------------------

SELECT attach_audit('agents');
SELECT attach_audit('agent_runs');
SELECT attach_audit('ai_drafts');
SELECT attach_audit('forensics_templates');
SELECT attach_audit('forensics_template_items');
SELECT attach_audit('forensics_checklists');
SELECT attach_audit('forensics_answers');
