-- Who can see what a run cost.
--
-- Until now every signed-in person saw the same application, which was right when the only people
-- signed in were the three principals. Model, effort and spend are now admin-only on the agents
-- page: they are operating detail about how the system is run rather than research anybody needs
-- to do their job, and a per-run dollar figure invites the wrong argument about which questions are
-- worth asking.
--
-- This does NOT weaken D5. "Cost is visible and true" is about the number never being a lie — v2's
-- dashboard reported $0.00 because nothing seeded its price table. An admin still sees the true
-- figure, and where it cannot be known it is still `<Blank>` rather than zero. What changed is the
-- audience, not the honesty.
--
-- Default false, deliberately: a new account is an ordinary one, and admin is granted on purpose by
-- someone with shell access (`jobs/set-admin.ts`). There is no route that grants it, for the same
-- reason there is no signup route.

ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_admin IS
  'Sees model, effort and spend on the agents page. Granted only from the VM.';
