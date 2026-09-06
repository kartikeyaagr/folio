import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from './db.ts';
import {
  cashBalance,
  confirmAction,
  DuplicateTrade,
  holdings,
  recordCapital,
  recordTrade,
  replay,
  replayCompany,
  reverseTrade,
} from './book.ts';

const DB = `trisula_book_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

const trade = (date: string, side: 'buy' | 'sell', quantity: number, price: number, fees = 0) => ({
  trade_date: date,
  side,
  quantity: String(quantity),
  price: String(price),
  fees: String(fees),
  created_at: new Date(date),
});

const bonus = (date: string, from: number, to: number) => ({
  kind: 'bonus' as const,
  record_date: date,
  ratio_from: String(from),
  ratio_to: String(to),
  amount_per_share: null,
});

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
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
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

// ---- the arithmetic, with no database in the way ------------------------------------------------

test('a buy sets the average to what was paid, fees included', () => {
  const p = replay([trade('2026-01-05', 'buy', 100, 50, 200)], []);
  assert.equal(p.quantity, 100);
  assert.equal(p.avgCost, 52); // (100*50 + 200) / 100
});

test('two buys average, weighted by size', () => {
  const p = replay([trade('2026-01-05', 'buy', 100, 50), trade('2026-02-05', 'buy', 100, 70)], []);
  assert.equal(p.quantity, 200);
  assert.equal(p.avgCost, 60);
});

test('a sell realises against the average and leaves it alone', () => {
  const p = replay(
    [trade('2026-01-05', 'buy', 100, 50), trade('2026-03-05', 'sell', 40, 80)],
    [],
  );
  assert.equal(p.quantity, 60);
  assert.equal(p.avgCost, 50, 'selling does not change what the rest cost');
  assert.equal(p.realisedGain, 40 * 30);
});

test('a 1:1 bonus doubles quantity AND halves average cost', () => {
  // The bug this exists to prevent: leaving average cost alone doubles total basis and prints a
  // fabricated ~50% unrealised loss on a company that simply issued free shares.
  const p = replay([trade('2026-01-05', 'buy', 100, 50)], [bonus('2026-06-01', 1, 2)]);
  assert.equal(p.quantity, 200);
  assert.equal(p.avgCost, 25);
  assert.equal(p.quantity * p.avgCost, 5000, 'total cost basis is unchanged; a bonus costs nothing');
});

test('a 1:5 split multiplies quantity and divides cost by five', () => {
  const p = replay([trade('2026-01-05', 'buy', 100, 500)], [
    { ...bonus('2026-06-01', 1, 5), kind: 'split' as const },
  ]);
  assert.equal(p.quantity, 500);
  assert.equal(p.avgCost, 100);
});

test('an action applies to the position as of its record date, not before it', () => {
  // A buy on the record date is in the position the bonus acts on.
  const p = replay(
    [trade('2026-01-05', 'buy', 100, 50), trade('2026-06-01', 'buy', 100, 50)],
    [bonus('2026-06-01', 1, 2)],
  );
  assert.equal(p.quantity, 400, 'both fills were held on the record date');
});

test('a buy after the record date is untouched by the action', () => {
  const p = replay(
    [trade('2026-01-05', 'buy', 100, 50), trade('2026-07-01', 'buy', 100, 25)],
    [bonus('2026-06-01', 1, 2)],
  );
  assert.equal(p.quantity, 300, '200 post-bonus plus 100 bought later');
});

test('a dividend changes neither quantity nor cost', () => {
  const p = replay([trade('2026-01-05', 'buy', 100, 50)], [
    { kind: 'dividend', record_date: '2026-06-01', ratio_from: null, ratio_to: null, amount_per_share: '5' },
  ]);
  assert.equal(p.quantity, 100);
  assert.equal(p.avgCost, 50);
});

// ---- through the database ----------------------------------------------------------------------

test('a double-submitted trade is refused, and a genuine repeat is not', async () => {
  await recordTrade({ companyId: CO, tradeDate: '2026-01-05', side: 'buy', quantity: 100, price: 50 }, ME);
  await assert.rejects(
    () => recordTrade({ companyId: CO, tradeDate: '2026-01-05', side: 'buy', quantity: 100, price: 50 }, ME),
    DuplicateTrade,
  );
  await recordTrade(
    { companyId: CO, tradeDate: '2026-01-05', side: 'buy', quantity: 100, price: 50, seq: 2 },
    ME,
  );
  const h = await holdings();
  assert.equal(h[0]?.quantity, '200.0000', 'two deliberate fills, not three');
});

test('a trade moves cash the right way', async () => {
  assert.equal(await cashBalance(), '-10000.00', 'two buys of 100 at 50');
  await recordCapital('capital_in', 100000, '2026-01-01', 'seed', ME);
  assert.equal(await cashBalance(), '90000.00');
});

test('reversing a trade removes its effect and its cash, but keeps the record', async () => {
  const id = await recordTrade(
    { companyId: CO, tradeDate: '2026-02-05', side: 'buy', quantity: 50, price: 60 }, ME,
  );
  await reverseTrade(id, 'entered against the wrong name', ME);
  const h = await holdings();
  assert.equal(h[0]?.quantity, '200.0000', 'back to the two real fills');
  const kept = await readTxn(async (c) => {
    const { rows } = await c.query<{ reversal_reason: string }>(
      'SELECT reversal_reason FROM transactions WHERE id = $1', [id],
    );
    return rows[0];
  });
  assert.equal(kept?.reversal_reason, 'entered against the wrong name', 'the row stays');
});

test('confirming a bonus replays the position; an unconfirmed one does nothing', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO corporate_actions (id, company_id, kind, record_date, ratio_from, ratio_to)
       VALUES ('a1', $1, 'bonus', '2026-03-01', 1, 2)`, [CO],
    );
  });
  await replayCompany(CO, ME);
  assert.equal((await holdings())[0]?.quantity, '200.0000', 'announced is not applied');

  await confirmAction('a1', ME);
  const h = (await holdings())[0];
  assert.equal(h?.quantity, '400.0000');
  assert.equal(h?.avgCost, '25.000000', 'and the average halved with it');
});

test('a confirmed dividend pays on the quantity held, into cash', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO corporate_actions (id, company_id, kind, record_date, amount_per_share)
       VALUES ('a2', $1, 'dividend', '2026-04-01', 2)`, [CO],
    );
  });
  const before = Number(await cashBalance());
  await confirmAction('a2', ME);
  assert.equal(Number(await cashBalance()) - before, 800, '400 shares at 2');
  assert.equal((await holdings())[0]?.quantity, '400.0000', 'a dividend is not a share issue');
});

test('a holding with no price shows no mark rather than vanishing', async () => {
  const h = (await holdings())[0];
  assert.equal(h?.close, null);
  assert.equal(h?.marketValue, null, 'null, not zero — the position is real, the price is missing');
  assert.equal(h?.cost, '10000.00', 'and what it cost is still known');
});

test('once a price exists the holding is marked', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO prices (symbol, on_date, isin, close) VALUES ('TEGA','2026-09-04','INE011A01019',30)`,
    );
  });
  const h = (await holdings())[0];
  assert.equal(h?.close, '30.0000');
  assert.equal(h?.marketValue, '12000.00');
  assert.equal(h?.pricedOn, '2026-09-04', 'and the date is shown, so a stale mark is visible');
});
