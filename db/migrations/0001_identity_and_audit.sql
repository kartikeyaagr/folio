-- Identity, and the trigger that makes an unattributed write impossible.
--
-- The whole point of this migration is `audit_fn()`. Everything else exists so that it has
-- something to reference.
--
-- Attribution is not a convention here and not a code review item. It RAISES. An INSERT, UPDATE or
-- DELETE on an audited table with `app.actor_id` unset fails, from the app, from a job, from a
-- migration, or from psql. Forgetting is loud. v2 established this and it is the cheapest good
-- idea in that system: about thirty lines, and unfakeable.
--
-- Actor ids are text rather than uuid so that a service principal is its own name. An audit row
-- reading `system:ingest` needs no join to be understood at 3am, and "who did this" is exactly
-- the question asked when nobody is awake to explain.

-- ------------------------------------------------------------------------------------------------
-- Actors
-- ------------------------------------------------------------------------------------------------

CREATE TABLE actors (
    id         text        PRIMARY KEY,
    kind       text        NOT NULL,
    label      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT actors_kind_check CHECK (kind IN ('person', 'service'))
);

COMMENT ON TABLE actors IS
    'Every identity that can write. People get a uuid; services are named after themselves.';

-- Background work is unprompted by design and still answerable. Seeded here rather than created on
-- demand so that a typo in a job is a foreign key violation, not a new principal nobody authorised.
INSERT INTO actors (id, kind, label) VALUES
    ('system:migration', 'service', 'Migration runner'),
    ('system:auth',      'service', 'Authentication'),
    ('system:ingest',    'service', 'Market data ingest'),
    ('system:agents',    'service', 'Agent runner'),
    ('system:alerts',    'service', 'Alert evaluation');

-- ------------------------------------------------------------------------------------------------
-- People
-- ------------------------------------------------------------------------------------------------

CREATE TABLE users (
    id            text        PRIMARY KEY REFERENCES actors (id),
    email         text        NOT NULL UNIQUE,
    name          text        NOT NULL,
    -- Argon2id encoded string, which carries its own parameters and salt. Null until the account
    -- is claimed: an account exists before its owner has ever set a password.
    password_hash text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    disabled_at   timestamptz
);

COMMENT ON TABLE users IS
    'Three of these. There is no signup route; seeding is the only way an account exists.';

CREATE TABLE sessions (
    -- sha256 of the cookie value. A stolen database does not yield usable session cookies.
    token_sha256 text        PRIMARY KEY,
    user_id      text        NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Recovery codes exist because there is no signup route and no password-reset email. Without them
-- a locked-out account is recovered by hand-editing the database, which is worse in every way.
CREATE TABLE recovery_codes (
    code_sha256 text        PRIMARY KEY,
    user_id     text        NOT NULL REFERENCES users (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    used_at     timestamptz
);

CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

-- ------------------------------------------------------------------------------------------------
-- The audit log, and the trigger that fills it
-- ------------------------------------------------------------------------------------------------

CREATE TABLE audit_log (
    id         bigserial   PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    actor_id   text        NOT NULL REFERENCES actors (id),
    table_name text        NOT NULL,
    op         text        NOT NULL,
    row_id     text,
    before     jsonb,
    after      jsonb,

    CONSTRAINT audit_log_op_check CHECK (op IN ('INSERT', 'UPDATE', 'DELETE'))
);

CREATE INDEX audit_log_table_row_idx ON audit_log (table_name, row_id, at DESC);
CREATE INDEX audit_log_actor_idx     ON audit_log (actor_id, at DESC);

CREATE FUNCTION audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    actor text := nullif(current_setting('app.actor_id', true), '');
    rid   text;
BEGIN
    -- The line this whole migration exists for. No actor, no write. Not a default, not a
    -- fallback, not 'unknown' — those all produce an audit trail that lies quietly.
    IF actor IS NULL THEN
        RAISE EXCEPTION
            'unattributed write to %: app.actor_id is not set', TG_TABLE_NAME
            USING HINT = 'Reach the database through writeTxn or serviceTxn, never a bare client.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM actors WHERE id = actor) THEN
        RAISE EXCEPTION 'unknown actor %', actor
            USING HINT = 'Service principals are seeded in migrations, not created on demand.';
    END IF;

    rid := CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ->> 'id' ELSE to_jsonb(NEW) ->> 'id' END;

    INSERT INTO audit_log (actor_id, table_name, op, row_id, before, after)
    VALUES (
        actor,
        TG_TABLE_NAME,
        TG_OP,
        rid,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
    );

    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Attaching by hand once per table is how a table quietly escapes the audit. This does it by name
-- so that adding a table is one call, and CI can assert coverage is total by comparing the trigger
-- catalogue against the table catalogue.
CREATE FUNCTION attach_audit(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format(
        'CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION audit_fn()', target);
END;
$$;

SELECT attach_audit('users');
SELECT attach_audit('sessions');
SELECT attach_audit('recovery_codes');

-- Deliberately NOT audited:
--   actors      seeded by migrations and otherwise immutable; auditing it would require an actor
--               to exist before the first actor exists.
--   audit_log   auditing the audit log is a recursion, and its own append-only shape is the record.
