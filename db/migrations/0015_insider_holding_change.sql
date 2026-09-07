-- A disclosure says how much changed hands. What makes it worth reading is what it left behind:
-- a promoter going from 21% to 25% and one going from 4% to nothing are the same 7.2m shares.
--
-- NSE reports both sides on every PIT row and the first version of this table dropped them, which
-- would have left every insider alert saying "sold 7,200,000 shares" and nothing about whether that
-- was a trim or an exit.

ALTER TABLE insider_transactions
  ADD COLUMN pct_before numeric(8,4),
  ADD COLUMN pct_after  numeric(8,4);
