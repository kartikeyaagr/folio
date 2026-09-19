-- Ask once, on first sign-in, about linking a mailbox.
--
-- `0055` let a person link their own mailbox so their daily update leaves from their own address.
-- Nothing told them it existed: it is behind a button in the avatar menu, which is where a thing
-- like this goes and also where it is never found. This is the one prompt worth interrupting a
-- first sign-in for.
--
-- **A prompt and not a gate.** Somebody who declines still gets their digest, through the shared
-- desk relay, exactly as before — decided at the fund's instruction 17-Sep-2026 after the
-- alternative was put: gating would mean one person's choice stops their own mail, and the two mail
-- agents are shared by the whole desk so a global gate would let one unlinked person stop
-- everybody's. Linking changes which address the mail comes from, and nothing else.
--
-- One column rather than a table. What is recorded is "this person has been asked", which is a fact
-- about the person, has exactly one value, and never needs a history. `mailboxes` already answers
-- "did they link one" and answering it twice is how the two come to disagree.
ALTER TABLE users ADD COLUMN mailbox_prompted_at timestamptz;

COMMENT ON COLUMN users.mailbox_prompted_at IS
  'When this person was offered the mailbox prompt. Set by dismissing OR by linking — the prompt is '
  'shown once either way. Null means they have never seen it.';

-- Everybody who already has an account has been using it; the prompt is for people arriving after
-- it existed. Without this the next sign-in of every current user opens a dialog about a feature
-- they may already have looked at, which is exactly the kind of thing that teaches people to
-- dismiss dialogs without reading them.
UPDATE users SET mailbox_prompted_at = now() WHERE created_at < now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE mailbox_prompted_at IS NULL) THEN
    RAISE EXCEPTION 'an existing account would have been prompted about a feature it predates';
  END IF;
END $$;
