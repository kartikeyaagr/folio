-- What the fund owns, what it paid, and where the cash went.
--
-- Weighted-average cost, not FIFO. FIFO existed in v2 to produce tax-correct STCG and LTCG, which
-- the fund administrator produces when an accountant asks. Average cost answers "what did this
-- position cost us" in a fraction of the code.
--
-- Holdings is a stored table, not a view, so there is an apply step to inspect and a constraint to
-- lean on. But it is rebuilt by **full replay** from transactions rather than updated in place,
-- which removes an entire class of drift: a back-dated trade, a reversal, or a corporate action
-- confirmed late all simply produce a different replay. There is no incremental state to go stale
-- and no watermark to be wrong.

-- ------------------------------------------------------------------------------------------------
-- Trades
-- ------------------------------------------------------------------------------------------------

CREATE TABLE transactions (
    id          text        PRIMARY KEY,
    company_id  text        NOT NULL REFERENCES companies (id),
    trade_date  date        NOT NULL,
    side        text        NOT NULL,
    quantity    numeric(20, 4) NOT NULL,
    price       numeric(20, 4) NOT NULL,
    fees        numeric(20, 4) NOT NULL DEFAULT 0,

    -- Two identical fills at one price on one day is routine. A boolean "override" flag would be a
    -- counter that only counts to two, so the discriminator is a number: null for the first, 2 for
    -- the second, and so on. It is part of the uniqueness key, which is what makes a double-
    -- submitted form collide while a genuine repeat does not.
    seq         integer,

    -- Reversal rather than deletion. What was recorded stays recorded; a mistake is corrected by
    -- an explicit act that is itself attributed.
    reversed_at timestamptz,
    reversed_by text        REFERENCES users (id),
    reversal_reason text,

    entered_by  text        NOT NULL REFERENCES users (id),
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT transactions_side_check CHECK (side IN ('buy', 'sell')),
    CONSTRAINT transactions_quantity_check CHECK (quantity > 0),
    CONSTRAINT transactions_price_check CHECK (price >= 0),
    CONSTRAINT transactions_reversal_check
        CHECK (reversed_at IS NULL OR (reversed_by IS NOT NULL AND reversal_reason IS NOT NULL))
);

-- The constraint that turns a double-submitted form into an error rather than a doubled position.
-- Reversed rows are excluded so a corrected trade can be re-entered identically.
CREATE UNIQUE INDEX transactions_unique_fill
    ON transactions (company_id, trade_date, side, quantity, price, coalesce(seq, 1))
    WHERE reversed_at IS NULL;

CREATE INDEX transactions_company_idx ON transactions (company_id, trade_date);

-- ------------------------------------------------------------------------------------------------
-- Corporate actions
-- ------------------------------------------------------------------------------------------------

-- Ingested unconfirmed, then confirmed by a person. Only confirmed actions affect the book:
-- an exchange feed announcing a bonus is not the same as the bonus having happened to us.
CREATE TABLE corporate_actions (
    id          text        PRIMARY KEY,
    company_id  text        NOT NULL REFERENCES companies (id),
    kind        text        NOT NULL,
    record_date date        NOT NULL,
    ex_date     date,

    -- A 1:1 bonus is from 1 to 2; a 1:5 split is from 1 to 5. The factor is to/from.
    ratio_from  numeric(20, 6),
    ratio_to    numeric(20, 6),
    -- Dividends are not a multiplier. Amount per share, and it moves cash rather than quantity.
    amount_per_share numeric(20, 4),

    applied_at  timestamptz,
    applied_by  text        REFERENCES users (id),
    source      text        NOT NULL DEFAULT 'nse',
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT corporate_actions_kind_check CHECK (kind IN ('bonus', 'split', 'dividend')),
    -- A quantity-changing action needs a ratio; a dividend needs an amount. Enforced here because
    -- an action with neither would replay as a silent no-op.
    CONSTRAINT corporate_actions_shape_check CHECK (
        (kind IN ('bonus', 'split') AND ratio_from > 0 AND ratio_to > 0 AND amount_per_share IS NULL)
     OR (kind = 'dividend' AND amount_per_share IS NOT NULL AND ratio_from IS NULL AND ratio_to IS NULL)
    ),
    CONSTRAINT corporate_actions_applied_check
        CHECK (applied_at IS NULL OR applied_by IS NOT NULL)
);

CREATE INDEX corporate_actions_company_idx ON corporate_actions (company_id, record_date);
CREATE INDEX corporate_actions_pending_idx ON corporate_actions (record_date) WHERE applied_at IS NULL;

-- ------------------------------------------------------------------------------------------------
-- Cash
-- ------------------------------------------------------------------------------------------------

-- Signs are the fund's: money arriving is positive. Nothing is typed in here by hand except
-- capital movements; every other row is written by a trade or a confirmed corporate action.
CREATE TABLE cash_ledger (
    id          text        PRIMARY KEY,
    on_date     date        NOT NULL,
    kind        text        NOT NULL,
    amount      numeric(20, 4) NOT NULL,
    company_id  text        REFERENCES companies (id),
    transaction_id text     REFERENCES transactions (id),
    action_id   text        REFERENCES corporate_actions (id),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT cash_ledger_kind_check
        CHECK (kind IN ('capital_in', 'capital_out', 'buy', 'sell', 'dividend', 'fees'))
);

CREATE INDEX cash_ledger_date_idx ON cash_ledger (on_date DESC);

-- ------------------------------------------------------------------------------------------------
-- Holdings
-- ------------------------------------------------------------------------------------------------

-- Quantity and cost only. Market value is NOT stored: it is quantity times the latest close, and
-- storing it would create a window between the 18:45 bhavcopy and any recompute where the headline
-- number is knowably wrong. Computed on read instead, with a LEFT JOIN so an unpriced holding
-- renders "no mark" rather than dropping out of a SUM.
CREATE TABLE holdings (
    company_id     text        PRIMARY KEY REFERENCES companies (id),
    quantity       numeric(20, 4) NOT NULL,
    avg_cost       numeric(20, 6) NOT NULL,
    realised_gain  numeric(20, 4) NOT NULL DEFAULT 0,
    -- The replay that produced this row, so a holding can be told apart from a stale one.
    replayed_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT holdings_quantity_check CHECK (quantity >= 0)
);

-- ------------------------------------------------------------------------------------------------

SELECT attach_audit('transactions');
SELECT attach_audit('corporate_actions');
SELECT attach_audit('cash_ledger');
SELECT attach_audit('holdings');
