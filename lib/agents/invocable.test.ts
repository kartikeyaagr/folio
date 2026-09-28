/**
 * Who a person may ask for work by hand, checked against what the handlers actually do.
 *
 * `INVOCABLE` is a claim about behaviour — *"this is the subject this agent's handler will go
 * looking for"* — and a table of four strings cannot be trusted to still be that claim a year from
 * now. So the claim is run: every agent on the list is enqueued with exactly the subject it
 * declares and has to produce a draft, and enqueued **without** it and has to fail.
 *
 * The second half is the point. Without it the list is only a list, and the bug it was written to
 * fix — `/agents` offering the desk analyst, whose handler threw before it read anything — would
 * have passed a test that checked the seeded rows and nothing else.
 *
 * The partition is exhaustive over the six seeded agents, asserted below, so a seventh cannot be
 * added without a decision being made about it here.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import { INVOCABLE, INVOCABLE_KEYS, isInvocable, missingSubject } from './invocable.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { enqueue } from './queue.ts';
import { drain } from './runner.ts';

// The handlers, imported for the side effect of registering themselves. All four that call a model,
// because this file's whole subject is which of them can run without a subject.
import './results.ts';
import './concall.ts';
import './forensics.ts';
import './newsbrief.ts';

const DB = `folio_inv_${process.pid}`;
const CO = 'c1';
const CRORE = 10_000_000;

/**
 * The subject each agent declares it needs. `y1` is the annual period seeded below; `t1` is the
 * transcript. Agents that declare `company` or `none` take no subject_ref, and the map says so by
 * omission.
 */
const SUBJECT: Record<string, string> = {
  'results-figures': 'y1',
  'concall-insights': 't1',
};

/** What each invocable agent would return, if it got as far as returning anything. */
const ANSWER: Record<string, Record<string, unknown>> = {
  'forensics-review': { version: 1, answers: [] },
  'news-brief': { period: 'the last 7 days', by_company: [], nothing_to_report: ['TEGA'], coming_up: [] },
  'results-figures': {
    headline: 'Revenue steady', figures: { revenue_cr: 900, profit_after_tax_cr: 60 },
    moved: [], one_offs: [], watch_items: [],
  },
  'concall-insights': {
    summary: 'They talked about capacity.', comparison_available: false,
    guidance_changes: [], commitments: [], unanswered: [],
  },
};

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    // `status = 'watching'` on purpose: `newsbrief.gather` filters to the names the fund follows,
    // and a company outside that set makes agent 6 throw `no companies to brief on` — which would
    // pass the failure half of this test for entirely the wrong reason.
    await c.query(
      "INSERT INTO companies (id,symbol,name,status) VALUES ($1,'TEGA','Tega Industries','watching')",
      [CO],
    );
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind,
                                 revenue, profit_after_tax)
       VALUES ('y1',$1,'consolidated','2024-04-01','2025-03-31','year',$2,$3)`,
      [CO, 900 * CRORE, 60 * CRORE],
    );
    await c.query("INSERT INTO actors (id,kind,label) VALUES ('p1','person','T')");
    await c.query("INSERT INTO users (id,email,name) VALUES ('p1','t@x.com','T')");
    // A transcript long enough to clear MIN_TRANSCRIPT_CHARS, which the handler refuses below.
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('t1',$1,'Q1 FY26 earnings call','transcript','p1')`, [CO]);
    await c.query(
      'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
      ['t1', JSON.stringify({ text: 'Operator: good evening. '.repeat(400) }), 'p1']);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

/** Every agent the registry knows about, and whether it calls a model at all. */
async function seeded(): Promise<{ key: string; model: string; enabled: boolean }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ key: string; model: string; enabled: boolean }>(
      'SELECT key, model, enabled FROM agents ORDER BY key',
    );
    return rows;
  });
}

test('every invocable agent is seeded, enabled, and calls a model', async () => {
  const rows = await seeded();
  for (const key of INVOCABLE_KEYS) {
    const row = rows.find((r) => r.key === key);
    assert.ok(row, `${key} is offered but not in the registry — an agent absent from that table cannot be invoked`);
    assert.equal(row.enabled, true, `${key} is offered but disabled`);
    assert.notEqual(row.model, 'none', `${key} is offered as work to ask for but calls no model`);
  }
});

// ---- the claim the list is making -----------------------------------------------------------------

for (const key of INVOCABLE_KEYS) {
  test(`${key} runs to a draft when given the ${INVOCABLE[key]!.subject} it declares`, async () => {
    await enqueue({
      agentKey: key,
      // Exactly what `askAgent` enqueues after its checks pass: the declared subject, and
      companyId: INVOCABLE[key]!.subject === 'none' ? null : CO,
      subjectRef: SUBJECT[key] ?? null,
    });

    const out = await drain(1, scriptedModel([scriptedOk(ANSWER[key]!)]));
    assert.equal(out.ran, 1, `${key} was not picked up`);
    assert.equal(out.failed, 0, `${key} failed on a run a person can actually ask for`);
    assert.equal(out.drafted, 1, `${key} produced no draft`);
  });
}

// ---- the reason everybody else is off it ----------------------------------------------------------

test('an agent denied the subject it declares fails, which is why the declaration is that subject', async () => {
  // The converse half. Without it, `subject` could say anything at all and every test above would
  // still pass, because they all hand the agent what it asked for.
  for (const key of INVOCABLE_KEYS) {
    if (INVOCABLE[key]!.subject === 'none') continue;
    await serviceTxn('system:agents', (c) => c.query('DELETE FROM agent_runs'));
    // Company withheld from the one that declares `company`, subject_ref from the two that declare
    // a row — in each case exactly the thing `missingSubject` would have refused at the form.
    await enqueue({
      agentKey: key,
      companyId: INVOCABLE[key]!.subject === 'company' ? null : CO,
      subjectRef: null,
    });

    // Scripted to succeed, so a failure here is the handler refusing the run rather than the model
    // declining it. Each of these throws before it would have called anything.
    const out = await drain(1, scriptedModel([scriptedOk(ANSWER[key]!)]));
    assert.equal(out.ran, 1, `${key} was not picked up`);
    assert.equal(
      out.failed, 1,
      `${key} ran without the ${INVOCABLE[key]!.subject} it declares — if that is now true, the ` +
        'declaration is wrong and the request desk is asking for something nobody needs',
    );
  }
});

test('missingSubject refuses exactly what the handler would have refused, and says which', async () => {
  // The form's check and the handler's failure have to be the same predicate, or a request gets
  // through the page and dies on the queue twenty minutes later.
  assert.equal(missingSubject('news-brief', null, null), null, 'needs nothing');
  assert.equal(missingSubject('forensics-review', CO, null), null);
  assert.match(missingSubject('forensics-review', null, null)!, /Pick a company/);
  assert.match(missingSubject('results-figures', CO, null)!, /filed period/);
  assert.match(missingSubject('concall-insights', CO, null)!, /which call/i);
  assert.match(missingSubject('email-workflow', CO, 'x')!, /cannot be asked/);
});

test('the two agents that call no model are the two excluded for the other reason', async () => {
  // `email-workflow` and `reminders` would both run happily with no subject. They are off the list
  // because there is nothing to ask them for: they drain the outbox and read what is due, on their
  // own schedule. The exclusion is not about what a form can supply, so it gets its own assertion
  // rather than being folded into the one above.
  const silent = (await seeded()).filter((r) => r.model === 'none').map((r) => r.key).sort();
  assert.deepEqual(silent, ['email-workflow', 'reminders']);
  // And every agent that DOES call a model is now askable, which was not true before the request
  // desk: the two needing a specific period or transcript were excluded for want of a picker.
  const modelled = (await seeded()).filter((r) => r.model !== 'none').map((r) => r.key).sort();
  assert.deepEqual(modelled, INVOCABLE_KEYS.slice().sort(), 'all four model-calling agents');
  for (const key of silent) assert.equal(isInvocable(key), false, `${key} is not work to ask for`);
});

test('every seeded agent is accounted for by exactly one of the three arguments above', async () => {
  // The partition, so an eighth agent cannot be added without somebody deciding which case it is.
  const rows = await seeded();
  const invocable = rows.filter((r) => isInvocable(r.key)).map((r) => r.key);
  const needsASubject = rows.filter((r) => !isInvocable(r.key) && r.model !== 'none').map((r) => r.key);
  const noModel = rows.filter((r) => !isInvocable(r.key) && r.model === 'none').map((r) => r.key);

  assert.equal(
    invocable.length + needsASubject.length + noModel.length, rows.length,
    'the three cases are disjoint and cover the registry',
  );
  // Six since `0053` cut the desk analyst. A seventh needs a case made for it here.
  assert.equal(rows.length, 6, 'six agents; a seventh needs a case made for it here');
});
