-- The names the fund follows, and what it writes about them.
--
-- Two tables that look similar and are not. `securities` is the exchange's list: every listed
-- instrument, refreshed from NSE, owned by nobody here. `companies` is the fund's own list: the
-- forty-odd names somebody decided to follow, each with a status a person set by hand.
--
-- Keeping them apart is what lets you add a company by symbol (the master answers "does this
-- exist and what is its ISIN") without the master's three thousand rows appearing anywhere a
-- person looks.

-- ------------------------------------------------------------------------------------------------
-- The exchange's list
-- ------------------------------------------------------------------------------------------------

CREATE TABLE securities (
    symbol      text        PRIMARY KEY,
    isin        text,
    name        text        NOT NULL,
    series      text,
    listed_on   date,
    face_value  numeric(18, 4),
    -- Absent from the last refresh rather than deleted: a delisted symbol still appears in old
    -- filings and old trades, and a row that vanishes takes those references with it.
    delisted_at timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX securities_isin_idx ON securities (isin) WHERE isin IS NOT NULL;
CREATE INDEX securities_name_idx ON securities (lower(name));

COMMENT ON TABLE securities IS
    'NSE''s master list, refreshed by ingest. Audited like everything else, so the ingest must '
    'write only rows that actually changed — an unconditional upsert would put three thousand '
    'no-op rows in the audit log on every run.';

-- ------------------------------------------------------------------------------------------------
-- The fund's list
-- ------------------------------------------------------------------------------------------------

CREATE TABLE companies (
    id          text        PRIMARY KEY,
    symbol      text        NOT NULL UNIQUE,
    isin        text,
    name        text        NOT NULL,

    -- Five words, set by hand, replacing v2's twelve enforced stages and the gates between them.
    -- Chosen 06-Sep-2026 to be the vocabulary actually used out loud:
    --   watching  a name being followed, not yet worked
    --   working   under research
    --   holding   owned
    --   exited    owned, then sold
    --   passed    looked at and declined, never owned
    -- exited and passed are both closed and are deliberately distinct: "we sold at 900" and "we
    -- passed at 400" are different lessons, and the graveyard is only useful if it keeps both.
    status      text        NOT NULL DEFAULT 'watching',

    -- Why a name is closed. Required for passed and exited, because a graveyard without reasons is
    -- a list of tickers nobody learns anything from.
    closed_reason text,
    closed_at     timestamptz,

    -- One covering analyst is enough for three people. Null means nobody, and alert routing treats
    -- that as "tell everyone" rather than "tell no one".
    covered_by  text        REFERENCES users (id),

    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT companies_status_check
        CHECK (status IN ('watching', 'working', 'holding', 'exited', 'passed')),
    -- A closed name states why. Enforced here rather than in a form, because the form is not the
    -- only thing that writes.
    CONSTRAINT companies_closed_reason_check
        CHECK (status NOT IN ('exited', 'passed') OR closed_reason IS NOT NULL)
);

CREATE INDEX companies_status_idx  ON companies (status);
CREATE INDEX companies_covered_idx ON companies (covered_by) WHERE covered_by IS NOT NULL;

-- Every other name a company answers to. Feeds the news matcher's wide net: registered name,
-- trading name, former names, brands and subsidiaries. `kind` is recorded so a match can say which
-- kind of name it hit, which is half of "why did this match".
CREATE TABLE company_aliases (
    id         bigserial PRIMARY KEY,
    company_id text      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    alias      text      NOT NULL,
    kind       text      NOT NULL,

    CONSTRAINT company_aliases_kind_check
        CHECK (kind IN ('name', 'former_name', 'brand', 'subsidiary', 'abbreviation')),
    CONSTRAINT company_aliases_unique UNIQUE (company_id, alias)
);

CREATE INDEX company_aliases_lookup_idx ON company_aliases (lower(alias));

-- ------------------------------------------------------------------------------------------------
-- What the fund writes
-- ------------------------------------------------------------------------------------------------

CREATE TABLE documents (
    id         text        PRIMARY KEY,
    company_id text        REFERENCES companies (id),
    title      text        NOT NULL,
    kind       text        NOT NULL DEFAULT 'note',
    created_by text        NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,

    CONSTRAINT documents_kind_check CHECK (kind IN ('note', 'memo', 'meeting', 'checklist'))
);

CREATE INDEX documents_company_idx ON documents (company_id, updated_at DESC)
    WHERE archived_at IS NULL;

-- Every save is a version. Not for undo — for the question "what did we think in March", which is
-- the question the whole product exists to answer three years later.
CREATE TABLE document_versions (
    id          bigserial   PRIMARY KEY,
    document_id text        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    body        jsonb       NOT NULL,
    summary     text,
    written_by  text        NOT NULL REFERENCES users (id),
    written_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_versions_doc_idx ON document_versions (document_id, written_at DESC);

-- Files, content-addressed. The digest is the identity, so the same PDF filed twice is one blob
-- with two references, and a file cannot be silently swapped for a different one under the same id.
CREATE TABLE attachments (
    sha256      text        PRIMARY KEY,
    company_id  text        REFERENCES companies (id),
    filename    text        NOT NULL,
    media_type  text        NOT NULL,
    bytes       bigint      NOT NULL,
    kind        text        NOT NULL,
    -- Where it came from, so a fetched file can be told from an uploaded one without guessing.
    source_note text,
    -- Extracted text, when there is any. Null means not attempted; empty means attempted and the
    -- document had none, which is the case a scanned page produces and is worth telling apart.
    extracted_text text,
    added_by    text        NOT NULL REFERENCES actors (id),
    added_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT attachments_kind_check
        CHECK (kind IN ('transcript', 'presentation', 'annual_report', 'filing', 'excel', 'other'))
);

CREATE INDEX attachments_company_idx ON attachments (company_id, added_at DESC);

-- ------------------------------------------------------------------------------------------------

SELECT attach_audit('securities');
SELECT attach_audit('companies');
SELECT attach_audit('company_aliases');
SELECT attach_audit('documents');
SELECT attach_audit('document_versions');
SELECT attach_audit('attachments');
