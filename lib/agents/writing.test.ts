/**
 * Agents 2, 3 and 6 — the three with no verifier under them.
 *
 * Nothing checks what these write except a person, so what is tested here is the **input**: that
 * the prompt says what is held and what is not, that a missing comparison is stated rather than
 * left for the model to infer, and that the news brief is never built on an ungated candidate.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { acceptDraft, pendingDrafts } from './review.ts';
import { briefs, brief, pendingBrief } from '../briefs.ts';
import { drain } from './runner.ts';
import { enqueue } from './queue.ts';
import * as concall from './concall.ts';
import './newsbrief.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_wr_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

const transcriptBody = (marker: string) => ({ text: `${marker} `.repeat(1200) });

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query(
      "INSERT INTO companies (id,symbol,name,sector) VALUES ($1,'PRAJIND','Praj Industries Limited','bioenergy')",
      [CO],
    );
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
  await serviceTxn('system:agents', async (c) => {
    // Documents before drafts: a document records the draft it came from, and the foreign key
    // holding that link refuses to let the draft go while it does.
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
    await c.query('DELETE FROM news_matches');
    await c.query('DELETE FROM news_items');
    await c.query('DELETE FROM filings');
  });
});

async function transcript(id: string, title: string, marker: string, writtenAt: string): Promise<void> {
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      "INSERT INTO documents (id,company_id,title,kind,created_by) VALUES ($1,$2,$3,'transcript',$4)",
      [id, CO, title, ME],
    );
    await c.query(
      'INSERT INTO document_versions (document_id, body, written_by, written_at) VALUES ($1,$2,$3,$4)',
      [id, JSON.stringify(transcriptBody(marker)), ME, writtenAt],
    );
  });
}

// ---- agent 2 ------------------------------------------------------------------------------------

async function newsItem(id: string, title: string, state: string, mechanism: string | null) {
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id,source_key,guid,url,title,published_at)
       VALUES ($1,'trade',$1,'https://x/a',$2, now())`, [id, title]);
    await c.query(
      `INSERT INTO news_matches (id,item_id,company_id,tier,evidence,state,mechanism)
       VALUES ($1,$1,$2,'sector_term','ethanol',$3,$4)`, [id, CO, state, mechanism]);
  });
}

test('a transcript too short to be one is never queued', async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      "INSERT INTO documents (id,company_id,title,kind,created_by) VALUES ('d0',$1,'Stub','transcript',$2)",
      [CO, ME],
    );
    await c.query(
      "INSERT INTO document_versions (document_id, body, written_by) VALUES ('d0','{\"text\":\"tbd\"}',$1)",
      [ME],
    );
  });
  assert.equal(await concall.sweep(), 0, 'an xhigh Opus call over a placeholder costs real money');
});

test('a real transcript is queued once, however often the sweep runs', async () => {
  await transcript('d1', 'Q2 FY26 call', 'alpha', '2026-08-01');
  assert.equal(await concall.sweep(), 1);
  assert.equal(await concall.sweep(), 0);
});

test('the prior call is supplied, and the delta is what is asked for', async () => {
  await transcript('d1', 'Q1 FY26 call', 'earlier', '2026-05-01');
  await transcript('d2', 'Q2 FY26 call', 'later', '2026-08-01');
  await enqueue({ agentKey: concall.KEY, subjectRef: 'd2', companyId: CO });

  const model = scriptedModel([scriptedOk({
    summary: 'A call.', comparison_available: true,
    guidance_changes: [{ topic: 'margin', previously: '18%', now: '20%', direction: 'raised' }],
    commitments: [], unanswered: [],
  })]);
  await drain(1, model);

  const task = model.calls[0]!.task;
  assert.match(task, /THIS CALL:/);
  assert.match(task, /THE PREVIOUS CALL/);
  assert.ok(task.includes('earlier'), 'the prior call is in the prompt, not just referenced');
});

test('with no prior call the prompt says so rather than leaving it to be inferred', async () => {
  // A model given no comparison and no note about it invents one.
  await transcript('d1', 'The first call', 'only', '2026-08-01');
  await enqueue({ agentKey: concall.KEY, subjectRef: 'd1', companyId: CO });
  const model = scriptedModel([scriptedOk({
    summary: 'A call.', comparison_available: false, guidance_changes: [], commitments: [], unanswered: [],
  })]);
  await drain(1, model);
  assert.match(model.calls[0]!.task, /No previous call is held/);
  assert.doesNotMatch(model.calls[0]!.task, /THE PREVIOUS CALL/);
});

test('the draft records that nothing checked it', async () => {
  await transcript('d1', 'A call', 'only', '2026-08-01');
  await enqueue({ agentKey: concall.KEY, subjectRef: 'd1', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({
    summary: 'A call.', comparison_available: false, guidance_changes: [], commitments: [], unanswered: [],
  })]));
  const v = await readTxn(async (c) => {
    const { rows } = await c.query<{ verification: { agreed: unknown; note: string } }>(
      'SELECT verification FROM ai_drafts',
    );
    return rows[0]?.verification;
  });
  assert.equal(v?.agreed, null, 'null, not true: nothing verified this');
  assert.match(String(v?.note), /no previous call was held/);
});

// ---- agent 3 ------------------------------------------------------------------------------------

test('the brief leads with filings, because for an SME they are the news', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at)
       VALUES ('f1',$1,'PRAJIND','Resignation of Director/KMP/SMP','The CFO has resigned', now())`, [CO]);
  });
  await enqueue({ agentKey: 'news-brief', requestedBy: ME });
  const model = scriptedModel([scriptedOk({
    period: 'last 7 days', by_company: [], nothing_to_report: [], coming_up: [],
  })]);
  await drain(1, model);

  const task = model.calls[0]!.task;
  assert.ok(task.indexOf('EXCHANGE FILINGS') < task.indexOf('CONFIRMED NEWS'), 'filings first');
  assert.match(task, /The CFO has resigned/);
});

test('an ungated candidate never reaches the brief', async () => {
  await newsItem('n1', 'A confirmed story', 'confirmed', 'It supplies those mills.');
  await newsItem('n2', 'An unjudged story', 'candidate', null);
  await newsItem('n3', 'A rejected story', 'rejected', null);
  await enqueue({ agentKey: 'news-brief', requestedBy: ME });
  const model = scriptedModel([scriptedOk({
    period: 'last 7 days', by_company: [], nothing_to_report: [], coming_up: [],
  })]);
  await drain(1, model);

  const task = model.calls[0]!.task;
  assert.match(task, /A confirmed story/);
  assert.doesNotMatch(task, /An unjudged story/, 'a brief on unexplained matches is how trust goes');
  assert.doesNotMatch(task, /A rejected story/);
  assert.match(task, /mechanism: It supplies those mills\./, 'and the reason travels with it');
});

test('a name with nothing gets an empty record rather than being left out', async () => {
  await enqueue({ agentKey: 'news-brief', requestedBy: ME });
  const model = scriptedModel([scriptedOk({
    period: 'last 7 days', by_company: [], nothing_to_report: ['PRAJIND'], coming_up: [],
  })]);
  await drain(1, model);
  const task = model.calls[0]!.task;
  assert.match(task, /PRAJIND/);
  assert.match(task, /EXCHANGE FILINGS:\n {4}none/);
  assert.match(task, /goes in \n?`nothing_to_report`|`nothing_to_report`/);
});

// ---- the runner, under a handler that breaks --------------------------------------------------

test('a handler that runs bad SQL records why, rather than being swallowed', async () => {
  // A failing statement poisons the transaction it ran in, so every later statement on that
  // connection returns "current transaction is aborted" — which names nothing and sends you to
  // read schemas. This used to be held off with `SAVEPOINT handler`; since R3 the handler's reads
  // and the row recording its failure are different transactions on different connections, so the
  // poisoned one is simply discarded. Lesson L6: the path that reports a failure must not depend
  // on the thing that failed. The assertions below are unchanged — only the mechanism is.
  // Deliberately an agent whose real handler this file never loads. `registerHandler` replaces a
  // handler globally, so breaking one this file also exercises breaks every later test that uses
  // it — which is what happened when this was moved off `company-dossier` (cut in 0034) onto
  // `news-brief`. The key must still name a live agent: `agent_runs.agent_key` is a foreign key.
  const { registerHandler } = await import('./runner.ts');
  registerHandler('forensics-review', async (ctx) => {
    await ctx.reads((c) => c.query('SELECT column_that_does_not_exist FROM companies'));
    return { done: true };
  });

  await enqueue({ agentKey: 'forensics-review', companyId: CO, requestedBy: ME });
  const r = await drain(1, scriptedModel([]));
  assert.equal(r.failed, 1);

  const run = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; error: string; failure_kind: string }>(
      'SELECT status, error, failure_kind FROM agent_runs ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0]!;
  });
  assert.match(run.error, /column_that_does_not_exist/, 'the actual cause survives');
  assert.equal(run.failure_kind, 'error');
  assert.notEqual(run.status, 'running', 'and it is not left claimed for the lease to clean up');
});

// ---- an accepted brief becomes a brief ---------------------------------------------------------

const BRIEF = {
  period: 'The last 7 days',
  by_company: [{ symbol: 'PRAJIND', what_happened: ['Nothing filed.'], why_it_matters: 'Quiet week.' }],
  nothing_to_report: ['AERON'],
  coming_up: ['PRAJIND — results, 30 September'],
};

async function acceptedBrief(): Promise<void> {
  await enqueue({ agentKey: 'news-brief', requestedBy: ME });
  await drain(1, scriptedModel([scriptedOk(BRIEF)]));
  const [draft] = await pendingDrafts();
  await acceptDraft(draft!.id, null, ME);
}

test('a brief waiting for review is visible before it is accepted', async () => {
  // Somebody who came to read this morning's brief should be told it exists and is waiting on a
  // person, not shown yesterday's and left to wonder.
  await enqueue({ agentKey: 'news-brief', requestedBy: ME });
  await drain(1, scriptedModel([scriptedOk(BRIEF)]));
  assert.notEqual(await pendingBrief(), null);
  assert.deepEqual(await briefs(), [], 'and it is not on the page until somebody accepts it');
});

test('an accepted brief is a brief, not an untitled note', async () => {
  await acceptedBrief();
  const [b] = await briefs();
  assert.ok(b, 'findable as a brief');
  assert.match(b.title, /The last 7 days/, 'and titled by its period rather than "news-brief draft"');
  assert.equal(b.covered, 1);
  assert.equal(b.quiet, 1);
  assert.equal(await pendingBrief(), null, 'and no longer waiting');
});

test('an accepted brief still knows which draft it came from', async () => {
  // The review gate spends its whole design showing provenance before you accept. Losing it at the
  // moment of acceptance loses it exactly when it starts to matter.
  await acceptedBrief();
  const [summary] = await briefs();
  const b = await brief(summary!.id);
  assert.ok(b!.fromDraftId, 'the draft is named');
  assert.equal(b!.model, 'claude-opus-5');
  assert.ok(Number(b!.costUsd) > 0, 'and what it cost came with it');
});

test('the whole brief survives acceptance, not a summary of it', async () => {
  await acceptedBrief();
  const [summary] = await briefs();
  const b = await brief(summary!.id);
  assert.deepEqual(b!.content['coming_up'], ['PRAJIND — results, 30 September']);
  assert.deepEqual(b!.content['nothing_to_report'], ['AERON']);
});
