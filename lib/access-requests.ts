/**
 * Asking for an account, and deciding about it.
 *
 * A request is not an account and this module creates none. Approval records a judgement; the
 * credential is still printed once by `jobs/seed-user.ts` on the VM, so a password never appears
 * in a browser. See migration `0032` for why the no-signup rule was reversed and what keeps the
 * reversal narrow.
 */

import { randomBytes } from 'node:crypto';

import { readTxn, serviceTxn, writeTxn } from './db.ts';

export class ReasonRequired extends Error {}
export class NoSuchRequest extends Error {}

export interface AccessRequest {
  id: string;
  email: string;
  name: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decidedNote: string | null;
}

const SELECT = `
  SELECT r.id, r.email, r.name, r.note, r.status, r.requested_at, r.decided_at,
         u.name AS decided_by_name, r.decided_note
    FROM access_requests r
    LEFT JOIN users u ON u.id = r.decided_by`;

interface Row {
  id: string;
  email: string;
  name: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
  decided_note: string | null;
}

const toRequest = (r: Row): AccessRequest => ({
  id: r.id,
  email: r.email,
  name: r.name,
  note: r.note,
  status: r.status,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at,
  decidedByName: r.decided_by_name,
  decidedNote: r.decided_note,
});

/**
 * Record a request, or refresh the one already standing for that address.
 *
 * **Says nothing about whether the address is already an account.** The caller gets the same
 * answer either way, because an unauthenticated endpoint that distinguishes them is a way to find
 * out who works here — the same property `login()` protects with its dummy hash.
 *
 * Written as `system:auth`: nobody is signed in, so there is no person to attribute it to, and the
 * request itself is the record of who asked.
 */
export async function requestAccess(email: string, name: string, note: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  const who = name.trim();
  if (!clean || !who) return;

  await serviceTxn('system:auth', async (c) => {
    // An account that already exists silently records nothing. The requester is told the same
    // thing as everybody else by the page above.
    const { rows: existing } = await c.query(
      'SELECT 1 FROM users WHERE lower(email) = $1 AND disabled_at IS NULL',
      [clean],
    );
    if (existing.length > 0) return;

    await c.query(
      `INSERT INTO access_requests (id, email, name, note)
       VALUES ($1, $2, $3, NULLIF(btrim($4), ''))
       ON CONFLICT (lower(email)) WHERE status = 'pending'
       DO UPDATE SET name = EXCLUDED.name,
                     note = EXCLUDED.note,
                     requested_at = now()`,
      [randomBytes(16).toString('hex'), clean, who, note],
    );
  });
}

export async function listRequests(status?: AccessRequest['status']): Promise<AccessRequest[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Row>(
      `${SELECT} WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
        LIMIT 200`,
      [status ?? null],
    );
    return rows.map(toRequest);
  });
}

export async function pendingCount(): Promise<number> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM access_requests WHERE status = 'pending'",
    );
    return Number(rows[0]?.n ?? 0);
  });
}

/**
 * Approve or reject, attributed to the admin who decided.
 *
 * A rejection needs a reason — the schema enforces it too. Approving does **not** create the
 * account: it records that somebody said yes, and the panel then shows the `seed-user` command to
 * run on the box. Keeping account creation on the VM is the whole reason this is only a request.
 */
export async function decideRequest(
  id: string,
  decision: 'approved' | 'rejected',
  actorId: string,
  note: string,
): Promise<AccessRequest> {
  const reason = note.trim();
  if (decision === 'rejected' && reason === '') {
    throw new ReasonRequired('Say why the request was refused.');
  }

  return writeTxn(actorId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE access_requests
          SET status = $2, decided_at = now(), decided_by = $3,
              decided_note = NULLIF($4, '')
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [id, decision, actorId, reason],
    );
    if (rows.length === 0) {
      throw new NoSuchRequest('That request is no longer pending; somebody may have decided it.');
    }
    const { rows: full } = await c.query<Row>(`${SELECT} WHERE r.id = $1`, [id]);
    return toRequest(full[0]!);
  });
}
