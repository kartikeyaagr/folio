import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from './db.ts';
import {
  acknowledge, desk, evaluateFilings, evaluateInsider, evaluatePrices, recipients, upcoming,
} from './alerts.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `folio_alerts_${process.pid}`;
const A = 'u_a';
const B = 'u_b';
const COVERED = 'c_covered';
const ORPHAN = 'c_orphan';

before(async () => {
  await createTestDatabase(DB);
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
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:alerts', async (c) => {
    await c.query('DELETE FROM notification_outbox');
    await c.query('DELETE FROM alerts');
    await c.query('DELETE FROM insider_transactions');
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
  // This category matches kmp_resignation (high) and auditor_change (critical). The rules are read
  // worst-first for exactly this reason: without that ordering the winner was whichever row
  // Postgres returned first, and this could have been filed as `high`.
  await filing(COVERED, 'COV', 'Resignation of Director and Change in Auditors', 1, 'f_two');
  const r = await evaluateFilings();
  assert.equal(r.raised, 1, 'one filing, one alert');
  assert.equal((await desk())[0]?.severity, 'critical', 'and the worse of the two');
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

// ---- insider disclosures ----------------------------------------------------------------------

async function disclosure(
  id: string,
  kind: string,
  category: string,
  daysAgo = 1,
  extra: { quantity?: number; before?: number; after?: number } = {},
) {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO insider_transactions
         (id, company_id, symbol, person, category, kind, quantity, pct_before, pct_after,
          disclosed_at)
       VALUES ($1,$2,'COV','A Person',$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval)`,
      [id, COVERED, category, kind, extra.quantity ?? null, extra.before ?? null,
       extra.after ?? null, String(daysAgo)],
    );
  });
}

test('a promoter selling raises, and an employee selling does not', async () => {
  await disclosure('d_prom', 'Sell', 'Promoters', 1, { quantity: 3200000, before: 21.05, after: 18.2 });
  await disclosure('d_emp', 'Sell', 'Employees/Designated Employees', 1, { quantity: 3000 });
  const r = await evaluateInsider();
  assert.equal(r.considered, 2);
  assert.equal(r.raised, 1, 'a designated employee selling 3,000 shares is not news');
});

test('the alert carries the holding on both sides', async () => {
  await disclosure('d_move', 'Sell', 'Promoters', 1, { quantity: 3200000, before: 21.05, after: 18.2 });
  await evaluateInsider();
  const item = (await desk())[0]!;
  assert.match(String(item.detail), /21\.05% to 18\.20%/, 'the point of reading the disclosure');
  assert.match(String(item.detail), /32,00,000/, 'lakhs, because that is how the desk reads');
});

test('a promoter buying is not an alert', async () => {
  await disclosure('d_buy', 'Buy', 'Promoters', 1, { quantity: 7200000 });
  assert.equal((await evaluateInsider()).raised, 0);
});

test('a pledge is critical and a revocation is silent', async () => {
  await disclosure('d_pledge', 'Pledge', 'Promoters', 1, { quantity: 1000000 });
  await disclosure('d_revoke', 'Pledge Revoke', 'Promoters', 1, { quantity: 1000000 });
  assert.equal((await evaluateInsider()).raised, 1);
  assert.equal((await desk())[0]?.severity, 'critical', 'a pledge stops the fund');
});

test('a decade of history arriving at once does not raise a decade of alerts', async () => {
  // A newly followed company brings its whole PIT history: PRAJIND arrived with 232 disclosures
  // back to 2016. Without a floor, adding a name would alert on every promoter sale since.
  await disclosure('d_old', 'Sell', 'Promoters', 900, { quantity: 100000 });
  await disclosure('d_new', 'Sell', 'Promoters', 2, { quantity: 100000 });
  const r = await evaluateInsider();
  assert.equal(r.considered, 1, 'the old one is not even considered');
  assert.equal(r.raised, 1);
});

test('re-evaluating raises nothing twice', async () => {
  await disclosure('d_once', 'Sell', 'Promoters', 1, { quantity: 100000 });
  assert.equal((await evaluateInsider()).raised, 1);
  assert.equal((await evaluateInsider()).raised, 0);
});

// ---- a removed name ---------------------------------------------------------------------------

/** Set as `removeCompany` leaves a name with history: the row kept and marked, never deleted. */
async function setRemoved(companyId: string, removed: boolean) {
  await serviceTxn('system:alerts', async (c) => {
    await c.query(
      `UPDATE companies
          SET removed_at = CASE WHEN $2::boolean THEN now() END,
              removed_by = CASE WHEN $2::boolean THEN $3::text END
        WHERE id = $1`,
      [companyId, removed, A],
    );
  });
}

test('a removed name raises nothing from its filings, its insiders or its prices', async () => {
  // Its history stays linked — that is what removal keeps — so `company_id IS NOT NULL`, which
  // was the whole filter on two of these, no longer means followed.
  await filing(COVERED, 'COV', 'Change in Auditors', 1, 'f_gone');
  await disclosure('d_gone', 'Pledge', 'Promoters', 1, { quantity: 1000000 });
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO prices (symbol,on_date,close) VALUES
         ('COV', current_date - 2, 100),
         ('COV', current_date - 1, 150)`,
    );
  });

  await setRemoved(COVERED, true);
  try {
    assert.deepEqual(await evaluateFilings(), { considered: 0, raised: 0 });
    assert.deepEqual(await evaluateInsider(), { considered: 0, raised: 0 });
    assert.deepEqual(await evaluatePrices(), { considered: 0, raised: 0 });
  } finally {
    await setRemoved(COVERED, false);
  }

  // Restored, the same three each raise, so the silence above was the removal and not the fixture.
  assert.equal((await evaluateFilings()).raised, 1);
  assert.equal((await evaluateInsider()).raised, 1);
  assert.equal((await evaluatePrices()).raised, 1);
});

test("a removed name's meetings leave the fortnight but are kept", async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO calendar_events (id, company_id, kind, title, on_date)
       VALUES ('e_gone', $1, 'board_meeting', 'Results', current_date + 3)
       ON CONFLICT (id) DO NOTHING`,
      [COVERED],
    );
  });
  await setRemoved(COVERED, true);
  try {
    assert.deepEqual((await upcoming()).map((e) => e.id), []);
  } finally {
    await setRemoved(COVERED, false);
  }
  assert.deepEqual((await upcoming()).map((e) => e.id), ['e_gone']);
});
