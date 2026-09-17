/**
 * Attributed database access.
 *
 * Every write in this system names who made it. That is not enforced here — it is enforced in
 * Postgres, by an audit trigger that RAISES when `app.actor_id` is unset. So an unattributed write
 * is impossible from the app, from a job, from a migration, or from psql. Forgetting is a loud
 * failure rather than a silent gap in the record.
 *
 * This file's only job is to set that GUC on every transaction, which is why there is no bare
 * `query()` export: reaching the database means choosing whose name the work is done under.
 *
 *   readTxn      no actor, no writes. Read-only transaction.
 *   writeTxn     a person, from their session.
 *   serviceTxn   a named service principal for unprompted work — `system:ingest`,
 *                `system:agents`. Background jobs are unprompted by design but still
 *                accountable, so "nobody triggered it" never means "nobody is answerable".
 *
 * Connection is over a unix socket, so Postgres needs no TCP listener on the VM.
 */

import pg from 'pg';

/**
 * A `date` column is a calendar date, not an instant, and node-postgres parses one into a JS Date
 * at *local* midnight. In IST that makes `2024-04-01`.toISOString() report `2024-03-31`, which is
 * how a reporting period silently moves a day. Dates are therefore handed back as the strings they
 * are, and only `timestamptz` becomes a Date.
 *
 * Found the hard way: the first fundamentals ingest appeared to store 2024-03-31..2024-12-30 for a
 * period the database actually held correctly.
 */
pg.types.setTypeParser(1082, (v: string) => v); // DATE

/**
 * Service principals allowed to act without a person. Closed set on purpose, and the same closed
 * set Postgres holds: `audit_fn` raises on an actor it has never been seeded, so a principal added
 * here without a migration fails at the first write rather than at review.
 */
export type ServicePrincipal =
  | 'system:ingest'
  | 'system:index'
  | 'system:agents'
  | 'system:alerts'
  | 'system:auth'
  | 'system:migration'
  | 'system:news'
  | 'system:news-gate';

export type Client = pg.PoolClient;

let pool: pg.Pool | undefined;

/** Lazy so importing this module never opens a socket — jobs and tests import it freely. */
function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // Small: three users and a handful of jobs on one box. A large pool here would only
    // make a runaway job harder to notice.
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

async function transaction<T>(
  actor: string | null,
  readOnly: boolean,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (actor !== null) {
      // set_config with is_local=true scopes it to this transaction, so a pooled connection
      // cannot leak one caller's identity into the next caller's work.
      await c.query('SELECT set_config($1, $2, true)', ['app.actor_id', actor]);
    }
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {
      /* the original error is the one worth raising */
    });
    throw err;
  } finally {
    c.release();
  }
}

/** Read-only. Sets no actor because nothing is being attributed. */
export function readTxn<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  return transaction(null, true, fn);
}

/** A person's write, attributed to their session's actor id. */
export function writeTxn<T>(actorId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return transaction(actorId, false, fn);
}

/** Unprompted work, attributed to a named service principal. */
export function serviceTxn<T>(principal: ServicePrincipal, fn: (c: Client) => Promise<T>): Promise<T> {
  return transaction(principal, false, fn);
}

/** Jobs are short-lived processes; closing lets them exit rather than hang on an idle socket. */
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Wait on a `NOTIFY` channel, on a connection of its own.
 *
 * **Deliberately not from the pool.** `LISTEN` binds to a session and holds it for the life of the
 * process, so taking one of ten pooled connections for it would leave nine — and the one thing a
 * watcher does when it wakes is open transactions. That is the shape that produced seven stuck
 * connections in this database on 17-Sep-2026, and it is cheap to not repeat.
 *
 * No actor is set: `LISTEN` writes nothing, so there is nothing to attribute, and the handler does
 * its own attributed work in its own transactions.
 *
 * Reconnects rather than exits. A watcher is a long-lived process and Postgres restarting under it
 * is an ordinary night, not a fault — but a watcher that has quietly stopped listening is
 * indistinguishable from a quiet desk, which is the failure this system keeps paying for.
 */
export async function listen(
  channel: string,
  onNotify: (payload: string) => Promise<void>,
  onError: (err: unknown) => void = (e) => console.error(String(e)),
): Promise<void> {
  for (;;) {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      // Serialised: the handler is a backfill, which takes minutes, and two of them racing on one
      // notification storm is what the lease exists to stop — better to never start the second.
      let working = Promise.resolve();
      c.on('notification', (n) => {
        working = working.then(() => onNotify(n.payload ?? '')).catch(onError);
      });
      // `LISTEN` cannot be parameterised, and a channel name is not user input — it is a constant
      // in this tree. Quoted anyway, so the statement is well-formed whatever is handed to it.
      await c.query(`LISTEN "${channel.replace(/"/g, '""')}"`);
      await new Promise<void>((_, reject) => {
        c.on('error', reject);
        c.on('end', () => reject(new Error(`the ${channel} connection ended`)));
      });
    } catch (err) {
      onError(err);
    } finally {
      await c.end().catch(() => {
        /* already gone; the reconnect below is the recovery */
      });
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
