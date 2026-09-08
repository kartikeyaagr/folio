-- A way to ask for an account.
--
-- **This reverses a decision recorded in four places.** `capabilities.md` E4 says "Login for three
-- people. No signup route."; `app/(public)/login/page.tsx` says there is no sibling register route
-- "and there should not be"; `lib/auth.ts` says "There is no signup route and there never will
-- be"; and the recovery-code design exists precisely because accounts are only made on the box.
-- Reversed deliberately on 08-Sep-2026 at the fund's request. Written down here so the next reader
-- finds a decision rather than an inconsistency.
--
-- What makes it defensible rather than a hole:
--
--   * A request is **not an account**. Nothing here grants access. Approval is a person deciding,
--     and the credential is still printed once by `jobs/seed-user.ts` on the VM — the rule that a
--     password never appears in a browser is unchanged.
--   * The app binds to loopback and is reached over Tailscale (§8), so the form is only reachable
--     by someone already on the tailnet.
--   * The endpoint is rate limited, which is why that landed first.
--
-- No password is stored. Holding an Argon2 hash for somebody who may never be approved would make
-- an unauthenticated endpoint that burns 64 MiB per submission, which is the attack the limiter
-- exists to stop.

CREATE TABLE access_requests (
  id           text PRIMARY KEY,
  email        text NOT NULL,
  name         text NOT NULL,
  -- Why they want in, in their words. The approver is deciding about a person, not a row.
  note         text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text REFERENCES users(id),
  -- Required to reject, the same way closing a company requires one: a refusal with no reason is
  -- unreviewable six months later.
  decided_note text,

  CONSTRAINT decided_together CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL) OR
    (status <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT rejection_needs_a_reason CHECK (
    status <> 'rejected' OR (decided_note IS NOT NULL AND length(btrim(decided_note)) > 0)
  )
);

-- One live request per address. A second submission updates the first rather than queuing a pile
-- of identical rows for the approver to wade through; a decided request does not block a new ask,
-- because circumstances change.
CREATE UNIQUE INDEX access_requests_one_pending
  ON access_requests (lower(email)) WHERE status = 'pending';

CREATE INDEX access_requests_queue ON access_requests (requested_at) WHERE status = 'pending';

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON access_requests
  FOR EACH ROW EXECUTE FUNCTION audit_fn();
