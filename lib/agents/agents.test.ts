/**
 * Agents 1 and 7, and specifically their verifiers.
 *
 * The verifier is the whole reason either agent is safe to run unattended, so it gets more
 * attention here than the prompt does.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { drain, enqueue } from './runner.ts';
import { pendingDrafts, acceptDraft } from './review.ts';
import * as results from './results.ts';
import * as forensics from './forensics.ts';

const DB = `trisula_ag2_${process.pid}`;
const ME = 'p1';
const CO = 'c1';
const CRORE = 10_000_000;

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega Industries')", [CO]);
    // A quarter: revenue 219.1 cr, PAT 1.28 cr.
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind,
                                 revenue, profit_after_tax, context_dates_disagreed)
       VALUES ('q1',$1,'consolidated','2024-10-01','2024-12-31','quarter',$2,$3,false)`,
      [CO, 219.1 * CRORE, 1.28 * CRORE],
    );
    // An annual, for agent 7.
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind,
                                 revenue, profit_after_tax)
       VALUES ('y1',$1,'consolidated','2024-04-01','2025-03-31','year',$2,$3)`,
      [CO, 900 * CRORE, 60 * CRORE],
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM forensics_answers');
    await c.query('DELETE FROM forensics_checklists');
    // Documents before drafts: a document records the draft it came from, and the foreign key
    // holding that link refuses to let the draft go while it does.
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

// ---- the sweep ----------------------------------------------------------------------------------

test('the sweep asks what has no run yet, and stops offering it once queued', async () => {
  const first = await results.pending();
  assert.deepEqual(first.map((w) => w.subjectRef), ['q1'], 'the quarter, not the annual');

  await enqueue({ agentKey: results.KEY, subjectRef: 'q1', companyId: CO });
  assert.deepEqual(await results.pending(), [], 'a queued subject is no longer pending');
});

test('agent 7 only offers periods longer than 300 days', async () => {
  const work = await forensics.pending();
  assert.deepEqual(work.map((w) => w.subjectRef), ['y1'],
    'a quarter would answer half the checklist wrongly and the rest not at all');
});

// ---- agent 1's verifier -------------------------------------------------------------------------

async function runResults(figures: Record<string, unknown>) {
  await enqueue({ agentKey: results.KEY, subjectRef: 'q1', companyId: CO });
  await drain(1, scriptedModel([
    scriptedOk({
      headline: 'Revenue steady', figures, moved: [], one_offs: [], watch_items: [],
    }),
  ]));
  return (await pendingDrafts())[0];
}

test('figures that match the filing are marked agreed', async () => {
  const d = await runResults({ revenue_cr: 219.1, profit_after_tax_cr: 1.28 });
  const v = d?.verification as { agreed: boolean };
  assert.equal(v.agreed, true);
});

test('a figure more than one percent off is a disagreement, and BOTH readings are kept', async () => {
  const d = await runResults({ revenue_cr: 260, profit_after_tax_cr: 1.28 });
  const v = d?.verification as {
    agreed: boolean;
    checks: { field: string; filed: number; model: number; agreed: boolean }[];
  };
  assert.equal(v.agreed, false);
  const rev = v.checks.find((c) => c.field === 'revenue_cr')!;
  assert.equal(rev.agreed, false);
  assert.equal(rev.filed, 219.1, 'the filed figure survives');
  assert.equal(rev.model, 260, 'and so does what the model said');
  // The content is untouched: nothing is silently corrected.
  const figures = d?.content['figures'] as Record<string, number>;
  assert.equal(figures['revenue_cr'], 260);
});

test('a figure the model declined to report counts as a disagreement, not a pass', async () => {
  const d = await runResults({ revenue_cr: null, profit_after_tax_cr: 1.28 });
  const v = d?.verification as { agreed: boolean; checks: { field: string; agreed: boolean }[] };
  assert.equal(v.agreed, false);
  assert.equal(v.checks.find((c) => c.field === 'revenue_cr')?.agreed, false);
});

test('with no comparable prior period the prompt says so rather than inviting an invention', async () => {
  await enqueue({ agentKey: results.KEY, subjectRef: 'q1', companyId: CO });
  const model = scriptedModel([scriptedOk({
    headline: 'h', figures: { revenue_cr: 219.1, profit_after_tax_cr: 1.28 },
    moved: [], one_offs: [], watch_items: [],
  })]);
  await drain(1, model);
  assert.match(String(model.calls[0]?.task), /No comparable prior period is held/);
});

// ---- agent 7's structural check -----------------------------------------------------------------

const fullAnswers = (verdict = 'concern') =>
  Array.from({ length: 14 }, (_, i) => ({ item: i + 1, verdict, note: 'n' }));

test('a complete, honest set passes the structural check', async () => {
  const answers = fullAnswers().map((a) =>
    [8, 10, 11].includes(a.item) ? { ...a, verdict: 'unanswerable' } : a,
  );
  const items = await readTxn(async (c) => forensics.activeChecklist(c));
  const v = forensics.verifyStructure(items.items, answers);
  assert.equal(v.agreed, true);
});

test('a missing item is caught, because an omission reads as if it were fine', async () => {
  const answers = fullAnswers().filter((a) => a.item !== 5);
  const items = await readTxn(async (c) => forensics.activeChecklist(c));
  const v = forensics.verifyStructure(items.items, answers);
  assert.equal(v.agreed, false);
  assert.deepEqual(v.missing, [5]);
});

test('"clear" on something no filing can show is caught', async () => {
  // Item 10 is culture and reputation. A filing cannot answer it.
  const answers = fullAnswers().map((a) => (a.item === 10 ? { ...a, verdict: 'clear' } : a));
  const items = await readTxn(async (c) => forensics.activeChecklist(c));
  const v = forensics.verifyStructure(items.items, answers);
  assert.equal(v.agreed, false);
  assert.deepEqual(v.overconfident, [10],
    'a clean bill of health from an absence of evidence is the failure this catches');
});

test('accepting a forensic draft lands a versioned checklist', async () => {
  await enqueue({ agentKey: forensics.KEY, subjectRef: 'y1', companyId: CO });
  const answers = fullAnswers().map((a) =>
    [8, 10, 11].includes(a.item) ? { ...a, verdict: 'unanswerable' } : a,
  );
  await drain(1, scriptedModel([scriptedOk({ version: 1, answers })]));

  const d = (await pendingDrafts())[0];
  assert.ok(d, 'expected a draft');
  await acceptDraft(d.id, null, ME);

  const landed = await readTxn(async (c) => {
    const { rows } = await c.query<{ version: number; n: string; unanswerable: string }>(
      `SELECT cl.version,
              count(*)::text AS n,
              count(*) FILTER (WHERE a.verdict = 'unanswerable')::text AS unanswerable
         FROM forensics_checklists cl JOIN forensics_answers a ON a.checklist_id = cl.id
        GROUP BY cl.version`,
    );
    return rows[0]!;
  });
  assert.equal(landed.version, 1, 'answers point at the version they were answered under');
  assert.equal(landed.n, '14');
  assert.equal(landed.unanswerable, '3');
});
