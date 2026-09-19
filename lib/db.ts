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
 * Hold one connection open and call back on every `NOTIFY` on a channel. Returns the function that
 * stops it.
 *
 * **Not from the pool, and it cannot be.** A pooled connection is handed back after the
 * transaction that borrowed it; a `LISTEN` on one survives only until the next caller gets it, and
 * then the notifications go to whoever holds it now. Worse, `LISTEN` holds the session for the life
 * of the process, so taking one of ten pooled connections would leave nine — and the one thing a
 * watcher does when it wakes is open transactions. That is the shape that produced seven stuck
 * connections in this database on 17-Sep-2026. This opens its own `pg.Client`, which is the one
 * place in this codebase that is true.
 *
 * No actor is set: `LISTEN` writes nothing, so there is nothing to attribute, and the handler does
 * its own attributed work in its own transactions.
 *
 * **Handlers are serialised.** A handler here may be a backfill that takes minutes, and two of them
 * racing on one notification storm is what the lease exists to stop — better to never start the
 * second. Each notification waits for the one before it.
 *
 * Reconnects on its own. A notify listener that quietly dies after a database restart is worse than
 * no listener, because the queue it was watching keeps filling and the screen keeps saying
 * everything is indexed — indistinguishable from a quiet desk, which is the failure this system
 * keeps paying for. It is still only ever a *nudge*: notifications sent while the socket was down
 * are gone, which is exactly why the caller must also poll something durable, and why `onReconnect`
 * exists. See `jobs/index-content.ts --watch` and `jobs/backfill-company.ts --watch`.
 */
export async function listen(
  channel: string,
  onNotify: (payload: string) => void | Promise<void>,
  opts: { onReconnect?: () => void; onError?: (err: unknown) => void } = {},
): Promise<() => Promise<void>> {
  // Rejected rather than escaped. Every channel name in this tree is a constant, so anything that
  // fails this is a bug at the call site and should say so there, not be quietly quoted into
  // working. This also keeps the identifier out of the `LISTEN` string, which cannot be a parameter.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`unsafe channel name ${channel}`);
  const onError = opts.onError ?? ((e: unknown) => console.error(String(e)));
  let client: pg.Client | undefined;
  let stopped = false;
  // Spans reconnects deliberately: a handler still running when the socket drops must finish before
  // the one the reconnect sweep queues behind it.
  let working: Promise<void> = Promise.resolve();

  const connect = async (): Promise<void> => {
    if (stopped) return;
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (n) => {
      if (n.channel !== channel) return;
      working = working.then(() => onNotify(n.payload ?? '')).catch(onError);
    });
    client.on('error', () => { void reconnect(); });
    client.on('end', () => { void reconnect(); });
    await client.connect();
    await client.query(`LISTEN ${channel}`);
  };

  const reconnect = async (): Promise<void> => {
    if (stopped || client === undefined) return;
    client.removeAllListeners();
    client = undefined;
    // A fixed second, not a backoff: the thing being waited on is a local Postgres coming back,
    // and a backoff that reached minutes would leave the queue unwatched long after it had.
    await new Promise((r) => setTimeout(r, 1000));
    await connect().then(() => opts.onReconnect?.()).catch(() => void reconnect());
  };

  await connect();
  return async () => {
    stopped = true;
    const c = client;
    client = undefined;
    c?.removeAllListeners();
    await c?.end().catch(() => { /* closing a dead socket is not an error worth raising */ });
    // A stop that returned while a backfill was mid-write would let the caller close the pool under
    // it. Wait for the chain to drain.
    await working.catch(() => { /* already reported through onError */ });
  };
}
