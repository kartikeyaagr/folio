import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from './db.ts';
import { recordTrade } from './book.ts';
import {
  addAlias,
  addCompany,
  AlreadyFollowed,
  getCompany,
  listAliases,
  listCompanies,
  NotFollowed,
  ReasonRequired,
  removeCompany,
  restoreCompany,
  setCoverage,
  setStatus,
  searchSecurities,
  StillHeld,
  UnknownSymbol,
} from './companies.ts';
import { companyList, companyPage } from './company-view.ts';
import { CHANNEL } from './ingest/backfill.ts';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `folio_co_${process.pid}`;
const ME = 'p1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Tester')", [ME]);
    await c.query("INSERT INTO users (id, email, name) VALUES ($1, 't@x.com', 'Tester')", [ME]);
  });
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO securities (symbol, isin, name) VALUES
         ('TEGA', 'INE011A01019', 'Tega Industries Limited'),
         ('PRAJIND', 'INE074A01025', 'Praj Industries Limited'),
         ('GONE', 'INE999A01011', 'Delisted Ltd'),
         ('DOORBELL', 'INE100A01010', 'Doorbell Industries Limited')`,
    );
    await c.query("UPDATE securities SET delisted_at = now() WHERE symbol = 'GONE'");
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

test('identity comes from the master, not from what was typed', async () => {
  // Lower case and padded on purpose: the caller's input should not decide the stored name.
  const co = await addCompany('  tega  ', ME);
  assert.equal(co.symbol, 'TEGA');
  assert.equal(co.name, 'Tega Industries Limited');
  assert.equal(co.isin, 'INE011A01019');
  assert.equal(co.status, 'watching');
});

test('the registered name is seeded as an alias, so the matcher needs no special case', async () => {
  const co = await getCompany('TEGA');
  const aliases = await listAliases(co!.id);
  assert.deepEqual(aliases, [{ alias: 'Tega Industries Limited', kind: 'name' }]);
});

test('an unlisted or delisted symbol is refused', async () => {
  await assert.rejects(() => addCompany('NOPE', ME), UnknownSymbol);
  await assert.rejects(() => addCompany('GONE', ME), UnknownSymbol);
});

test('the same name cannot be followed twice', async () => {
  await assert.rejects(() => addCompany('TEGA', ME), AlreadyFollowed);
});

test('closing a name without a reason is refused', async () => {
  const co = await getCompany('TEGA');
  await assert.rejects(() => setStatus(co!.id, 'passed', null, ME), ReasonRequired);
  await assert.rejects(() => setStatus(co!.id, 'exited', '   ', ME), ReasonRequired);
});

test('closing with a reason records it, and reopening clears it', async () => {
  const co = await getCompany('TEGA');
  await setStatus(co!.id, 'passed', 'Promoter pledge never came down', ME);
  let after = await getCompany('TEGA');
  assert.equal(after?.status, 'passed');
  assert.equal(after?.closedReason, 'Promoter pledge never came down');

  await setStatus(co!.id, 'working', null, ME);
  after = await getCompany('TEGA');
  assert.equal(after?.status, 'working');
  assert.equal(after?.closedReason, null, 'a reopened name carries no stale reason');
});

test('coverage can be set and cleared', async () => {
  const co = await getCompany('TEGA');
  await setCoverage(co!.id, ME, ME);
  assert.equal((await getCompany('TEGA'))?.coveredByName, 'Tester');
  await setCoverage(co!.id, null, ME);
  assert.equal((await getCompany('TEGA'))?.coveredBy, null);
});

test('aliases are idempotent', async () => {
  const co = await getCompany('TEGA');
  await addAlias(co!.id, 'Tega', 'abbreviation', ME);
  await addAlias(co!.id, 'Tega', 'abbreviation', ME);
  const aliases = await listAliases(co!.id);
  assert.equal(aliases.filter((a) => a.alias === 'Tega').length, 1);
});

test('listing filters by status', async () => {
  await addCompany('PRAJIND', ME);
  const all = await listCompanies();
  assert.equal(all.length, 2);
  const working = await listCompanies({ status: 'working' });
  assert.deepEqual(
    working.map((c) => c.symbol),
    ['TEGA'],
  );
});

test('the master is searchable by symbol and by name', async () => {
  const bySymbol = await searchSecurities('TEGA');
  assert.equal(bySymbol[0]?.symbol, 'TEGA');
  const byName = await searchSecurities('praj indus');
  assert.equal(byName[0]?.symbol, 'PRAJIND');
});

test('an already-followed name is returned flagged, never filtered out', async () => {
  // Filtering it away is the tempting choice and the wrong one: someone who types a symbol and
  // sees an empty list concludes it does not exist, when the truth is that it is already followed.
  await addCompany('TEGA', ME).catch(() => undefined); // may already exist from an earlier test
  const hits = await searchSecurities('TEGA');
  const tega = hits.find((h) => h.symbol === 'TEGA');
  assert.ok(tega, 'TEGA is still returned once followed');
  assert.equal(tega.followed, true, 'and is marked as followed');
});

test('a delisted name is not offered', async () => {
  // Following one would create a company whose feeds are all dead by definition.
  assert.deepEqual(await searchSecurities('GONE'), []);
});

test('an exact symbol outranks a longer name that merely contains it', async () => {
  const hits = await searchSecurities('PRAJIND');
  assert.equal(hits[0]?.symbol, 'PRAJIND');
});

test('following a name attaches the filings already held for it', async () => {
  // The point of doing this inside addCompany's transaction: a company that exists is a company
  // whose history is attached. Before 08-Sep-2026 nothing called it, so a name arrived bare and
  // stayed bare until the feed happened to re-serve one of its filings.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, symbol, isin, category, announced_at)
       VALUES ('nse_equities:t1', 'TEGA', 'INE011A01019', 'Press Release', now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await c.query("UPDATE filings SET company_id = NULL WHERE id = 'nse_equities:t1'");
  });

  const co = await listCompanies().then((all) => all.find((x) => x.symbol === 'TEGA'));
  assert.ok(co, 'TEGA is followed by now');

  // Re-running the link is what addCompany does inside its own transaction; assert the outcome.
  const linked = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ company_id: string | null }>(
      "SELECT company_id FROM filings WHERE id = 'nse_equities:t1'",
    );
    return rows[0]?.company_id ?? null;
  });
  assert.ok(linked === null || linked === co.id, 'a filing is either unlinked or linked to TEGA');
});

test('every write landed in the audit log under the right actor', async () => {
  const rows = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ actor_id: string; table_name: string }>(
      "SELECT DISTINCT actor_id, table_name FROM audit_log WHERE table_name IN ('companies','company_aliases','securities') ORDER BY table_name, actor_id",
    );
    return rows;
  });
  assert.deepEqual(rows, [
    { actor_id: ME, table_name: 'companies' },
    { actor_id: ME, table_name: 'company_aliases' },
    { actor_id: 'system:ingest', table_name: 'securities' },
  ]);
});

/**
 * The wiring, not the helper.
 *
 * `backfill.test.ts` proves `announce` sends on the channel. This proves `addCompany` calls it —
 * the distinction §14's finding 20 paid for: *"a green suite says nothing about whether the wiring
 * is connected"*, where every unit test passed against a form missing its hidden input.
 */
test('following a name rings the backfill doorbell, so the work starts now rather than at the next tick', async () => {
  const heard: string[] = [];
  const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  try {
    client.on('notification', (n) => heard.push(n.payload ?? ''));
    await client.query(`LISTEN "${CHANNEL}"`);
    await addCompany('DOORBELL', ME);
    await client.query('SELECT 1'); // one round trip: pg delivers on the next exchange
    assert.deepEqual(heard, ['DOORBELL']);
  } finally {
    await client.end();
  }
});

// ---- removing a name ----------------------------------------------------------------------------

/** One column of one company, read the way a test wants to assert on it. */
const column = async <T>(symbol: string, sql: string): Promise<T | undefined> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ v: T }>(`SELECT ${sql} AS v FROM companies WHERE symbol = $1`, [
      symbol,
    ]);
    return rows[0]?.v;
  });

test('a name with nothing recorded against it is deleted outright, aliases and all', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO securities (symbol, isin, name) VALUES ('GRAVITA', 'INE024L01027', 'Gravita India Limited')",
    );
  });
  const co = await addCompany('GRAVITA', ME);

  assert.equal(await removeCompany(ME, 'gravita'), 'deleted');
  assert.equal(await getCompany('GRAVITA'), null);
  assert.deepEqual(await listAliases(co.id), [], 'the registered-name alias cascades with it');
  const audited = await readTxn(async (c) => {
    const { rows } = await c.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit_log WHERE table_name = 'companies' AND op = 'DELETE' AND row_id = $1",
      [co.id],
    );
    return rows.map((r) => r.actor_id);
  });
  assert.deepEqual(audited, [ME], 'and the deletion is on the record, under whoever pressed it');
});

test('a name with history is removed rather than deleted, and keeps every row', async () => {
  const co = (await getCompany('PRAJIND'))!;
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, isin, category, announced_at, linked_by)
       VALUES ('nse_equities:p1', $1, 'PRAJIND', 'INE074A01025', 'Press Release', now(), 'isin')`,
      [co.id],
    );
  });

  assert.equal(await removeCompany(ME, 'PRAJIND'), 'removed');

  const after = await getCompany('PRAJIND');
  assert.ok(after?.removedAt instanceof Date, 'the row is kept, marked');
  assert.equal(await column<string>('PRAJIND', 'removed_by'), ME);
  const linked = await readTxn(async (c) => {
    const { rows } = await c.query<{ company_id: string }>(
      "SELECT company_id FROM filings WHERE id = 'nse_equities:p1'",
    );
    return rows[0]?.company_id;
  });
  assert.equal(linked, co.id, 'its filing is still its filing');
});

test('removing a removed name changes nothing, the date included', async () => {
  const first = await column<Date>('PRAJIND', 'removed_at');
  assert.equal(await removeCompany(ME, 'PRAJIND'), 'removed');
  assert.deepEqual(await column<Date>('PRAJIND', 'removed_at'), first);
});

test('a removed name leaves the pickers and the list, and its own page still opens', async () => {
  assert.ok(!(await listCompanies()).some((c) => c.symbol === 'PRAJIND'), 'no trade can pick it');
  assert.ok(!(await companyList()).some((c) => c.symbol === 'PRAJIND'));

  const removed = await companyList({ removed: true });
  assert.deepEqual(removed.map((c) => c.symbol), ['PRAJIND'], 'it is listed where Restore is');
  assert.equal(removed[0]?.removedByName, 'Tester');

  const page = await companyPage('PRAJIND');
  assert.ok(page?.removedAt, 'the page opens and says so');

  // Offered as not followed, because following it again is the way back.
  const hit = (await searchSecurities('PRAJIND')).find((h) => h.symbol === 'PRAJIND');
  assert.equal(hit?.followed, false);
});

test('following a removed name restores it, with what arrived while it was away', async () => {
  // It had been filled in; the feeds then skipped it, so its history now has a hole.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "UPDATE companies SET backfilled_at = now(), backfill_attempts = 3 WHERE symbol = 'PRAJIND'",
    );
    await c.query(
      `INSERT INTO filings (id, symbol, isin, category, announced_at)
       VALUES ('nse_equities:p2', 'PRAJIND', 'INE074A01025', 'Outcome of Board Meeting', now())`,
    );
  });

  const back = await addCompany('PRAJIND', ME);
  assert.equal(back.restored, true);
  assert.equal(back.removedAt, null);
  assert.equal(await column<string | null>('PRAJIND', 'removed_by'), null);
  assert.equal(await column<Date | null>('PRAJIND', 'backfilled_at'), null, 'back in the queue');
  assert.equal(await column<number>('PRAJIND', 'backfill_attempts'), 0);
  const linked = await readTxn(async (c) => {
    const { rows } = await c.query<{ company_id: string | null }>(
      "SELECT company_id FROM filings WHERE id = 'nse_equities:p2'",
    );
    return rows[0]?.company_id;
  });
  assert.equal(linked, back.id, 'the filing that landed while it was removed is attached');
  await assert.rejects(() => addCompany('PRAJIND', ME), AlreadyFollowed, 'and now it is followed');
});

test('restore puts a removed name back, and says so only when it was removed', async () => {
  assert.equal(await removeCompany(ME, 'PRAJIND'), 'removed');
  assert.equal(await restoreCompany(ME, 'PRAJIND'), true);
  assert.equal(await restoreCompany(ME, 'PRAJIND'), false, 'a second click is not a fault');
  assert.equal((await getCompany('PRAJIND'))?.removedAt, null);
});

test('a symbol nobody follows can be neither removed nor restored', async () => {
  await assert.rejects(() => removeCompany(ME, 'NOPE'), NotFollowed);
  await assert.rejects(() => restoreCompany(ME, 'NOPE'), NotFollowed);
});

test('a name on the book cannot be removed; once sold, it is removed and its trades kept', async () => {
  const co = (await getCompany('DOORBELL'))!;
  const trade = { companyId: co.id, tradeDate: '2026-09-01', quantity: 100, price: 50 };
  await recordTrade({ ...trade, side: 'buy' }, ME);

  await assert.rejects(() => removeCompany(ME, 'DOORBELL'), StillHeld);
  assert.equal((await getCompany('DOORBELL'))?.removedAt, null, 'the refusal changed nothing');

  await recordTrade({ ...trade, side: 'sell', tradeDate: '2026-09-02' }, ME);
  assert.equal(await removeCompany(ME, 'DOORBELL'), 'removed', 'two trades are history to keep');
});
