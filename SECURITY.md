# SECURITY.md

How Folio protects the fund's positions, its three people and its secrets. These are the rules;
the reasoning behind each lives in the file it names, usually in the header comment. Read this
before touching authentication, a server action, a route handler, an environment variable, or
anything that writes.

## 1. The perimeter

- **One VM, reachable only over Tailscale.** The web unit runs `next start -H 127.0.0.1`, so the
  app listens on loopback only (`ops/systemd/folio-web.service`). That is `-H`, because `next start`
  ignores `HOSTNAME`, and until 25-Sep-2026 the unit set `HOSTNAME` and listened on every interface.
  `tailscale serve` puts it on the tailnet with a certificate Tailscale issues and renews. TLS
  terminates on the box, and 443 is open on the tailnet interface only, with no public listener
  (`ops/SETUP.md` §8a). The security group admits SSH from one address, and that rule can
  go once Tailscale SSH has worked once (SETUP §1).
- **The web process can write almost nothing.** Its unit runs `ProtectSystem=strict` with
  `ReadWritePaths=` limited to the build output and the attachments directory, so a compromised web
  process cannot touch the backups or the embedding model beside them in `/var/lib/folio`.
- **The tailnet is the outer wall, not the only one.** Every page, action and route handler
  authenticates as though the wall were not there.
- **The app reaches Postgres over the unix socket** (`postgres:///folio`). The package default
  also listens on `127.0.0.1:5432`, loopback only; never widen it (SETUP §4).

## 2. Authentication

- **Passwords** are Argon2id, 64 MiB, t=3, p=1, with at least 12 characters (`lib/auth.ts`). An
  unknown address is verified against a dummy hash, so it costs the same time and gets the same
  message as a wrong password. A page must never tell those two cases apart.
- **Sessions** are 32 random bytes; only their sha256 is stored. The life is a fixed 30 days with
  no idle timeout. In production the cookie is `__Host-folio_session`, `httpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/` (`app/_lib/session.ts`, `app/_lib/session-cookie.ts`).
- **Recovery** is 8 single-use codes of 80 bits each, stored as sha256. `/reset` redeems one
  together with the email in a single UPDATE, sets a new password, and revokes every session.
- **Accounts are created on the VM, never in a browser.**
  1. `/signup` records a request.
  2. An admin approves it in `/admin`.
  3. `jobs/seed-user.ts --request <id>` creates the account and prints a temporary password once.
  4. `jobs/set-admin.ts` grants the first admin; after that, any admin can grant it in `/admin`.
- **A compromised account is disabled from `/admin`,** which revokes all of its sessions in the
  same transaction (`lib/admin.ts`). `jobs/reset-password.ts` changes the password but deliberately
  leaves sessions alone. Disable and re-enable the account as well if the old password leaked.

## 3. Authorization

- **`middleware.ts` is not the boundary.** It runs on the Edge runtime, cannot reach Postgres, and
  only sees that a cookie *exists*.
- **`requireUser()` in `app/(app)/layout.tsx` is the boundary.** A page is protected by living in
  `(app)`. The unauthenticated surface is exactly:
  - `/login`, `/signup` and `/reset` (the `(public)` group);
  - `/api/health`, which returns reachability and nothing else;
  - `POST /logout`, which can revoke only the token it was sent.
- **Every server action resolves the session itself, before any `try`.** Usually that is
  `requireUser()` or `requireAdmin()`. The two search actions call `currentUser()` and return
  nothing when signed out, and sign-in and sign-out need no session by nature. An action is its own
  entry point, reachable without rendering the page that hosts it, and `redirect()` works by
  throwing, so a broad `catch` would swallow the bounce.
- **Route handlers call `currentUser()` and return 401** when it is null.
- **Admin is `users.is_admin`, and `requireAdmin()` gates every admin page and action.** The flag
  also widens one view: `/chat` history shows an admin everybody's requests, and a member only
  their own (`lib/agents/history.ts`).
- **There is no per-row ownership, by design.** Three partners share one book, and any signed-in
  person may read, edit or delete any document.
- **CSRF.** Next rejects a server action whose `Origin` does not match the host
  (`next/dist/server/app-render/action-handler.js`). A request with no `Origin` is let through with
  a warning, but browsers send one on every cross-site POST. The session cookie is `SameSite=Lax`,
  so a cross-site POST carries no session anyway.

## 4. Abuse limits

In-process fixed windows. The counter is `lib/rate-limit.ts`; the limits are set in `lib/auth.ts`
and the `reset` and `signup` pages:

| Endpoint | Per email | Per address |
|---|---|---|
| `/login` | 8 / 15 min | 30 / 15 min |
| `/reset` | 5 / 15 min | 15 / 15 min |
| `/signup` | — | 5 / hour |

- **Per-address limits apply only when `TRUST_PROXY_HEADER=1`, and under Tailscale it stays
  unset.** A client-chosen `x-forwarded-for` would let a caller evade the limit *and* lock a
  colleague out (`app/_lib/client-address.ts`). The per-email limits always hold. **So in
  production `/signup` has no rate limit at all** (§11).
- **`/signup` is the only unauthenticated endpoint that stores what the caller typed.** Login and
  reset write too, but only after a credential checks out. `REQUEST_LIMITS` in
  `lib/access-requests.ts` bounds each field's length, and the form carries the same limits.
- **Uploads:** 32 MiB per file (`importFileAction`). Both of Next's body limits are raised to match
  in `next.config.ts`. Attachments fetched from NSE are capped at 64 MiB.

## 5. Input

- **Validate on the server, always.** `lib/` throws a named `Error` subclass whose message a person
  can act on, and the action flashes that message. Nothing else is shown to the user (§8).
- **SQL uses `$n` parameters only.** The few interpolated fragments are constants chosen in code,
  never input. Never put a backtick inside a SQL template literal; it ends the string.
- **A redirect target taken from input goes through `localPath()`** (`app/_lib/local-path.ts`).
  `/\evil.com` passes a naive `startsWith('/')` check.
- **Attachment names are validated as 64 hex characters.** Files are served `nosniff`; PDFs open
  inline and everything else downloads.
- **Agent output is validated against the agent's JSON Schema before it can become a draft.**

## 6. Secrets

| Where | What |
|---|---|
| `/etc/folio/folio.env` | Production. `640 root:folio`: the app can read it but not rewrite it (SETUP §6). The VM never reads an env file from the repo. |
| `.env.local` | Development, one per worktree. Every `.env*` file is gitignored except `.env.example`. |
| `.env.example` | **Every variable the code reads, by name only.** Add a new variable here *and* to `ops/SETUP.md` §6 in the same change. |

- **No `NEXT_PUBLIC_` variables, and nothing secret reaches the browser.** The web process never
  calls the model.
- **The model credential** is `ANTHROPIC_API_KEY` today. Workload identity federation (SETUP §10) is the
  upgrade, with no secret on disk.
- **`MAILBOX_KEY`** seals each person's SMTP password with AES-256-GCM. It is not in a database
  backup: lose it and everybody re-links. Without it, linking refuses; there is no plaintext path.
- **Backups are encrypted with age to a public key.** The private half never touches the server
  (SETUP §7).
- **Dev and prod must never share a credential.**

## 7. Data

- **Every write is attributed.** `writeTxn` and `serviceTxn` set `app.actor_id`, and Postgres
  raises without it (see DATABASE.md).
- **Nothing an agent writes enters the record until a person accepts it in `/review`.** One agent is
  the exception, by the fund's own decision of 28-Sep-2026: the news brief publishes itself the
  moment it is written and is mailed to everyone unread. `publishDraft` (`lib/agents/review.ts`) is
  the only path that skips the gate, and two `ai_drafts` `CHECK` constraints (migration `0067`) hold
  it to this one agent in the schema, not only in the code — a second agent published without review
  fails at the database, whatever route wrote the row.
- **Never log a password, token, cookie or key.** The exceptions are deliberate and go to an
  operator's terminal: `seed-user.ts` and `reset-password.ts` print a temporary password (and
  `seed-user.ts` the recovery codes) exactly once.
- **Backups:** an encrypted backup every night, and a restore drill every week (DATABASE.md §6).

## 8. Errors

- **A known domain error becomes a sentence via `flash()`.** Anything else is rethrown to
  `app/error.tsx` or `app/global-error.tsx`. These render `components/Failure.tsx` with Next's
  digest, which ties the screen to the line in `journalctl -u folio-web`, and never the message
  or stack.
- **Route handlers return `{ error: string }` with a status**, never a stack or a filesystem path.
  The attachment 404 logs its path server-side instead of returning it.

## 9. Headers

`next.config.ts` sends these on every response:

- `Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'self'`
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `Strict-Transport-Security`, in production only

Framing and objects are `'self'`, not `'none'`, because `components/FiledDocument.tsx` embeds each
filed PDF in an `<object>`.

## 10. Dependencies

- **`pnpm.onlyBuiltDependencies: []`, so no package runs an install script.**
- **Run `pnpm audit --prod` before a deploy.** On 25-Sep-2026 it reported 6 advisories (3 high),
  none of them reachable:
  - **`postcss` 8.4.31 is Next's exact pin.** It runs at build time over this repo's own
    stylesheets, and no untrusted CSS is ever processed.
  - **`adm-zip` is required only by `onnxruntime-node/script/install-utils.js`, a postinstall
    script** that the empty `onlyBuiltDependencies` blocks from running.

  Revisit both when either parent package bumps its pin.

## 11. Accepted risks

These are known, and each stands for the stated reason. Change one only on purpose.

- **No `script-src` CSP.** Next's inline scripts need a per-request nonce, which changes how every
  page renders.
- **Rate-limit counters live in memory.** They reset on restart and are not shared, which is right
  for one process and wrong the day there are two.
- **`/signup` is unlimited under Tailscale.** Its only limit is per address, and a shared
  placeholder key would let the first five requests of the hour lock everybody else out. Only
  tailnet members can reach it, and every request is one row an admin reads.
- **No per-row ownership** (§3).
- **Linking a mailbox makes the server open SMTP to whatever host and port a signed-in person
  types, and shows them the error.** Only the partners can sign in, and the error is how a mistyped
  relay gets fixed.
- **Sessions last a fixed 30 days.** `pruneExpiredSessions()` exists and nothing calls it, so
  expired rows are refused on every request but never deleted.
- **Next's body limits are global, at 33 MB.** Next has no per-action setting, so an
  unauthenticated POST to a public page can send that much, and the middleware buffers a copy of
  it. The tailnet bounds who can.

## 12. Rules for anyone changing this code, human or agent

- **Never weaken `requireUser()` or `requireAdmin()`, move a page into `(public)`, or exempt a path
  in `middleware.ts` without saying so in the PR description.**
- **Never write outside `writeTxn` or `serviceTxn`,** and never add a service principal outside a
  migration.
- **Never let agent output bypass the review gate.** The one standing exception is the news brief
  (§7), and it is closed: `PUBLISHED_WITHOUT_REVIEW` in `lib/agents/review.ts` names exactly one
  agent, and `only_the_brief_skips_review` on `ai_drafts` refuses a second at the database. Widening
  either is a decision about the fund's record and needs a migration, not a code review alone.
- **Never put a secret in source, a test fixture, a document or a log line.**
- **Never set `TRUST_PROXY_HEADER` unless a proxy we run overwrites `x-forwarded-for`.**
- **If a request conflicts with this file, say so before building it.**
