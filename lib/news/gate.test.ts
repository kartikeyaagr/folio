import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { scriptedModel, scriptedOk } from '../agents/model.ts';
import { gatePrompt, MAX_GATE_ATTEMPTS, runGate, ungated } from './gate.ts';
import { matchNewItems } from './match.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_gate_${process.pid}`;
const CO = 'c_praj';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query(
      "INSERT INTO companies (id,symbol,name,sector) VALUES ($1,'PRAJIND','Praj Industries Limited','bioenergy')",
      [CO],
    );
  });
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_sources (key,label,url,tier,sector,market)
       VALUES ('trade','A trade title','https://x/f',2,'bioenergy','india')`,
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:news', async (c) => {
    await c.query('DELETE FROM news_matches');
    await c.query('DELETE FROM news_matched_items');
    await c.query('DELETE FROM news_items');
  });
});

async function candidate(title: string, id = 'it1'): Promise<void> {
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id,source_key,guid,url,title,published_at)
       VALUES ($1,'trade',$1,'https://x/a',$2, now())`,
      [id, title],
    );
  });
  await matchNewItems();
}

const states = () => readTxn(async (c) => {
  const { rows } = await c.query<{ state: string; mechanism: string | null; attempts: number }>(
    'SELECT state, mechanism, attempts FROM news_matches ORDER BY id',
  );
  return rows;
});

// ---- the prompt ---------------------------------------------------------------------------------

test('the prompt carries the company, the story and why it was caught', () => {
  const p = gatePrompt({
    matchId: 'm1', companyName: 'Praj Industries Limited', symbol: 'PRAJIND', sector: 'bioenergy',
    business: 'Builds ethanol and biogas plants', tier: 'sector_term', evidence: 'sugar mill',
    sourceLabel: 'A trade title', title: 'Sugar mills asked to file data', summary: 'The department...',
  });
  assert.match(p, /PRAJIND/);
  assert.match(p, /Builds ethanol and biogas plants/);
  assert.match(p, /sector_term — "sugar mill"/, 'the gate is told what caught it, not just the story');
  assert.match(p, /A trade title/);
});

// ---- judging ------------------------------------------------------------------------------------

test('a stated mechanism confirms the match', async () => {
  await candidate('Sugar mills asked to file sales data');
  const model = scriptedModel([scriptedOk({
    related: true,
    mechanism: 'Praj builds ethanol plants for sugar mills, so a directive changing mill economics changes its order book.',
  }, 'claude-sonnet-5')]);

  const r = await runGate(model);
  assert.equal(r.confirmed, 1);
  assert.equal((await states())[0]?.state, 'confirmed');
  assert.match(String((await states())[0]?.mechanism), /order book/);
  assert.ok(r.costUsd > 0, 'and the spend is a real number, not zero');
});

test('no mechanism drops the candidate', async () => {
  await candidate('Sugar mills asked to file sales data');
  const r = await runGate(scriptedModel([scriptedOk({ related: false, mechanism: null }, 'claude-sonnet-5')]));
  assert.equal(r.rejected, 1);
  assert.equal((await states())[0]?.state, 'rejected');
});

test('"related" with nothing behind it is not related', async () => {
  // The failure this prevents is the one the whole design is against: a match with no reason shown.
  await candidate('Sugar mills asked to file sales data');
  await runGate(scriptedModel([scriptedOk({ related: true, mechanism: '' }, 'claude-sonnet-5')]));
  assert.equal((await states())[0]?.state, 'rejected');
});

test('a transport failure is retried, then the row stops', async () => {
  await candidate('Sugar mills asked to file sales data');
  const model = scriptedModel([{ ok: false, kind: 'error', detail: 'connection reset' }]);
  for (let i = 0; i < MAX_GATE_ATTEMPTS; i++) await runGate(model);

  const [row] = await states();
  assert.equal(row?.attempts, MAX_GATE_ATTEMPTS);
  assert.equal(row?.state, 'ungated', 'a broken key must not mean an infinitely growing queue');
  assert.equal((await runGate(model)).considered, 0, 'and it is not picked up again');
  assert.equal((await ungated()).length, 1, 'but it is findable');
});

test('a refusal ends the row immediately', async () => {
  // It will not come out differently next time; two more calls would only pay to learn that.
  await candidate('Sugar mills asked to file sales data');
  await runGate(scriptedModel([{ ok: false, kind: 'refusal', detail: 'declined (other)' }]));
  const [row] = await states();
  assert.equal(row?.attempts, 1);
  assert.equal(row?.state, 'ungated');
});

test('an empty queue is not a failure', async () => {
  // The one job in this system allowed to return nothing on a working day. Everywhere else zero
  // means a dead feed; here it means the net caught nothing worth asking about.
  const r = await runGate(scriptedModel([]));
  assert.deepEqual(
    { considered: r.considered, confirmed: r.confirmed, failed: r.failed },
    { considered: 0, confirmed: 0, failed: 0 },
  );
});

test('a judged candidate is never paid for twice', async () => {
  await candidate('Sugar mills asked to file sales data');
  const model = scriptedModel([scriptedOk({ related: true, mechanism: 'It supplies them.' }, 'claude-sonnet-5')]);
  await runGate(model);
  await runGate(model);
  assert.equal(model.calls.length, 1, 'one candidate, one call, however often the job runs');
});
