import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from './db.ts';
import { acknowledge, desk, evaluateFilings, evaluatePrices, recipients } from './alerts.ts';

const DB = `trisula_alerts_${process.pid}`;
const A = 'u_a';
const B = 'u_b';
const COVERED = 'c_covered';
const ORPHAN = 'c_orphan';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    for (const [id, name] of [[A, 'Ana'], [B, 'Bo']]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, name]);
      await c.query("INSERT INTO users (id,email,name) VALUES ($1,$2,$3)", [id, `${id}@x.com`, name]);
    }
    await c.query(
      "INSERT INTO companies (id,symbol,name,covered_by) VALUES ($1,'COV','Covered Ltd',$2)",
      [COVERED, A],
    );
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'ORP','Orphan Ltd')", [ORPHAN]);
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:alerts', async (c) => {
    await c.query('DELETE FROM notification_outbox');
    await c.query('DELETE FROM alerts');
    await c.query('DELETE FROM filings');
    await c.query('DELETE FROM prices');
  });
});

async function filing(company: string, symbol: string, category: string, daysAgo: number, id = 'f1') {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, linked_by)
       VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval, 'symbol')`,
      [id, company, symbol, category, String(daysAgo)],
    );
  });
}

// ---- routing --------------------------------------------------------------------------------

test('critical reaches everyone, even when the name is covered', async () => {
  const to = await readTxn((c) => recipients(c, COVERED, 'critical'));
  assert.deepEqual(to.sort(), [A, B], 'the covering analyst may be on a plane');
});

test('anything else reaches the covering analyst alone', async () => {
  assert.deepEqual(await readTxn((c) => recipients(c, COVERED, 'high')), [A]);
});

test('a name nobody covers reaches everyone', async () => {
  // The important case and the easy one to get wrong: routing must never make an alert vanish.
  assert.deepEqual((await readTxn((c) => recipients(c, ORPHAN, 'low'))).sort(), [A, B]);
});

test('a disabled covering analyst falls back to everyone, not to nobody', async () => {
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [A]);
  });
  assert.deepEqual(await readTxn((c) => recipients(c, COVERED, 'high')), [B]);
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [A]);
  });
});

// ---- evaluation -----------------------------------------------------------------------------

test('a resignation raises at high, and a board outcome at low', async () => {
  await filing(COVERED, 'COV', 'Resignation of Director/KMP/SMP', 1, 'f_res');
  await filing(COVERED, 'COV', 'Outcome of Board Meeting', 1, 'f_bm');
  const r = await evaluateFilings();
  assert.equal(r.raised, 2);
  const items = await desk();
  assert.equal(items[0]?.severity, 'high', 'severity first, so the resignation is on top');
  assert.match(String(items[0]?.title), /Resignation/);
  assert.equal(items[1]?.severity, 'low');
});

test('an old filing is not dropped for landing outside a window', async () => {
  // The bug this replaces: the evaluator used a rolling window and lost two real resignation
  // filings that landed one day outside it. It now asks what has no alert yet.
  await filing(COVERED, 'COV', 'Resignation of Director/KMP/SMP', 21, 'f_old');
  const r = await evaluateFilings();
  assert.equal(r.raised, 1, 'three weeks old and still raised');
});

test('re-evaluating raises nothing twice', async () => {
  await filing(COVERED, 'COV', 'Change in Auditors', 1, 'f_aud');
  assert.equal((await evaluateFilings()).raised, 1);
  const second = await evaluateFilings();
  assert.equal(second.raised, 0);
  assert.equal(second.considered, 0, 'and an already-alerted filing is not even reconsidered');
});

test('an auditor change is critical and notifies everyone', async () => {
  await filing(COVERED, 'COV', 'Change in Auditors', 1, 'f_aud2');
  await evaluateFilings();
  const n = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM notification_outbox WHERE kind='alert'",
    );
    return rows[0]!.n;
  });
  assert.equal(n, '2', 'critical goes to both, despite COV being covered by one');
});

test('a filing for a company nobody follows raises nothing', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, symbol, category, announced_at)
       VALUES ('f_un','NOPE','Change in Auditors', now())`,
    );
  });
  assert.equal((await evaluateFilings()).raised, 0);
});

test('one filing raises one alert, at the highest matching severity', async () => {
  // "Resignation" also contains no auditor words, but a pledge disclosure could match twice.
  await filing(COVERED, 'COV', 'Pledge of shares / encumbrance', 1, 'f_pl');
  const r = await evaluateFilings();
  assert.equal(r.raised, 1);
  assert.equal((await desk())[0]?.severity, 'critical');
});

// ---- price moves ----------------------------------------------------------------------------

test('a sharp move raises, a quiet one does not', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO prices (symbol,on_date,close) VALUES
         ('COV', current_date - 2, 100),
         ('COV', current_date - 1, 112)`,
    );
  });
  assert.equal((await evaluatePrices()).raised, 1);
  assert.match(String((await desk())[0]?.title), /12\.00%/);
});

// ---- the desk -------------------------------------------------------------------------------

test('acknowledging clears it from the desk but keeps the record', async () => {
  await filing(COVERED, 'COV', 'Change in Auditors', 1, 'f_ack');
  await evaluateFilings();
  const item = (await desk())[0]!;
  await acknowledge(item.id, A);
  assert.equal((await desk()).length, 0);
  const kept = await readTxn(async (c) => {
    const { rows } = await c.query<{ acknowledged_by: string }>(
      'SELECT acknowledged_by FROM alerts WHERE id = $1', [item.id],
    );
    return rows[0];
  });
  assert.equal(kept?.acknowledged_by, A);
});
