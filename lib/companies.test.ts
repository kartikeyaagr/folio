import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, serviceTxn } from './db.ts';
import {
  addAlias,
  addCompany,
  AlreadyFollowed,
  getCompany,
  listAliases,
  listCompanies,
  ReasonRequired,
  setCoverage,
  setStatus,
  UnknownSymbol,
} from './companies.ts';

const DB = `trisula_co_${process.pid}`;
const ME = 'p1';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Tester')", [ME]);
    await c.query("INSERT INTO users (id, email, name) VALUES ($1, 't@x.com', 'Tester')", [ME]);
  });
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO securities (symbol, isin, name) VALUES
         ('TEGA', 'INE011A01019', 'Tega Industries Limited'),
         ('PRAJIND', 'INE074A01025', 'Praj Industries Limited'),
         ('GONE', 'INE999A01011', 'Delisted Ltd')`,
    );
    await c.query("UPDATE securities SET delisted_at = now() WHERE symbol = 'GONE'");
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
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
