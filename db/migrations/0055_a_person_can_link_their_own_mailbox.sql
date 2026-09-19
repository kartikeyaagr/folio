-- A person can link their own mailbox, and the daily digest goes out through it.
--
-- At the fund's instruction, 17-Sep-2026. Until now every mail left through one shared relay
-- (`SMTP_*` in the box's environment) and arrived from one address. A linked mailbox means a
-- person's own daily update is sent from their own company address: it passes their domain's SPF
-- and DKIM, it threads with the rest of their mail, and there is no shared `desk@` box whose
-- password three people know.
--
-- **This is the first reversible secret in this schema, and that is the thing to be careful about.**
-- Everything stored until now is one-way: `users.password_hash` is Argon2id, `sessions.token_sha256`
-- and `recovery_codes` are sha256 of high-entropy values. None of them can be turned back into what
-- was typed. A mailbox password must be, because SMTP AUTH sends it. The rules that keep that
-- honest, all enforced in `lib/mailbox.ts` rather than here:
--
--   1. **AES-256-GCM, keyed from `MAILBOX_KEY` in the box's environment.** Not pgcrypto: `vector`
--      is the only extension this schema has and a second one for this would put the key in the
--      database beside the ciphertext, which is not encryption, it is filing.
--   2. **No plaintext fallback, ever.** With `MAILBOX_KEY` unset, linking REFUSES. A system that
--      quietly stores a password in the clear when a setting is missing is worse than one that
--      cannot store it at all, because nothing about it looks wrong.
--   3. **The web process encrypts and never decrypts.** Credentials are verified at the moment they
--      are typed, by sending a real message with them, and then sealed. Only the job that sends the
--      digest opens them. There is no screen, anywhere, that can display this column.
--   4. **A GCM tag, so tampering is detected rather than decrypted into nonsense.**
--
-- What this is NOT: a mailbox the system reads. There is no IMAP here and nothing fetches. The
-- credential is used for one thing — sending that person their own digest — and `lib/digest.ts` is
-- its only reader.

CREATE TABLE mailboxes (
  -- One per person, and the primary key says so: linking twice replaces rather than accumulates,
  -- and there is no question of which of two rows is live.
  user_id      text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  host         text NOT NULL,
  port         int  NOT NULL DEFAULT 587,
  username     text NOT NULL,
  -- `iv.tag.ciphertext`, base64 each, dot-separated. Opaque here on purpose: the shape is
  -- lib/mailbox.ts's business and a column comment describing it would be a map for anybody who
  -- got this far.
  secret       text NOT NULL,
  -- What the mail says it is from. Separate from `username` because a relay may authenticate one
  -- way and send as another, and Hostinger in particular refuses a From: that is not the box.
  from_address text NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  -- The last time this mailbox actually carried something, and the last thing that went wrong.
  -- A linked mailbox that stopped working is invisible otherwise: the digest falls back to the
  -- shared relay and nobody notices their address quietly stopped being theirs.
  last_ok_at   timestamptz,
  last_error   text,

  CONSTRAINT mailboxes_port_is_a_port CHECK (port > 0 AND port < 65536),
  -- STARTTLS submission or implicit TLS. 25 is refused deliberately: it is the port that talks to
  -- other servers, usually unencrypted, and a credential must never cross it.
  CONSTRAINT mailboxes_port_is_submission CHECK (port IN (465, 587, 2525))
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON mailboxes
  FOR EACH ROW EXECUTE FUNCTION audit_fn();

COMMENT ON TABLE mailboxes IS
  'A person''s own SMTP credentials, used only to send them their own daily digest. The secret is '
  'AES-256-GCM under MAILBOX_KEY; see lib/mailbox.ts. Nothing reads mail.';

COMMENT ON COLUMN mailboxes.last_error IS
  'Why the last send through this mailbox failed. Shown to its owner so a dead link is visible '
  'rather than silently falling back to the shared relay.';
