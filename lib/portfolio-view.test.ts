/**
 * The screens' reading of the book.
 *
 * One thing is worth pinning here rather than trusting: the quantity a pending corporate action is
 * shown against has to be the quantity the confirm will use. They come from the same replay now,
 * and this is the case that made counting the fills wrong.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { confirmAction, holdings, recordTrade } from './book.ts';
import { serviceTxn } from './db.ts';
import { pendingActions } from './portfolio-view.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `trisula_pview_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query(
      "INSERT INTO companies (id,symbol,isin,name) VALUES ($1,'TEGA','INE011A01019','Tega')",
      [CO],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

test('the quantity shown against an action is the one the confirm will use', async () => {
  await recordTrade(
    { companyId: CO, tradeDate: '2026-01-10', side: 'buy', quantity: 1000, price: 50 },
    ME,
  );
  await serviceTxn('system:ingest', async (c) => {
    // A bonus that has already happened to us, and a dividend that has not.
    await c.query(
      `INSERT INTO corporate_actions (id, company_id, kind, record_date, ratio_from, ratio_to)
       VALUES ('a1', $1, 'bonus', '2026-02-01', 1, 2)`, [CO],
    );
    await c.query(
      `INSERT INTO corporate_actions (id, company_id, kind, record_date, amount_per_share)
       VALUES ('a2', $1, 'dividend', '2026-03-01', 3)`, [CO],
    );
  });

  await confirmAction('a1', ME);
  assert.equal((await holdings())[0]?.quantity, '2000.0000', 'the bonus doubled the position');

  const [pending] = await pendingActions();
  assert.equal(pending?.id, 'a2', 'the confirmed one is gone from the list');
  // Summing the fills to 2026-03-01 gives 1,000 — the position before the bonus. The dividend will
  // be paid on 2,000, so 1,000 on the screen would be a promise the ledger then breaks.
  assert.equal(pending?.quantityAtRecord, 2000);
});

test('an action on a name with nothing held reads as nothing, not as a missing figure', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO companies (id,symbol,isin,name) VALUES ('c2','NOPE','INE011A01027','Nope')",
    );
    await c.query(
      `INSERT INTO corporate_actions (id, company_id, kind, record_date, amount_per_share)
       VALUES ('a3', 'c2', 'dividend', '2026-04-01', 1)`,
    );
  });
  const shown = await pendingActions();
  assert.equal(shown.find((a) => a.id === 'a3')?.quantityAtRecord, 0);
});
