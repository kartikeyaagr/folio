/**
 * Who may see what somebody asked an agent for.
 *
 * One person's requests are their own; an admin sees everybody's. That is an access rule, so what
 * matters is not that the right rows come back but that the wrong ones never do — and the only way
 * to know is to ask as somebody who should not see them.
 *
 * The rule is a `WHERE` clause rather than a filter after the query, deliberately, so these assert
 * against what the database returns rather than against what a page chose to render.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { serviceTxn } from '../db.ts';
import { askedCounts, askedRuns } from './history.ts';

const DB = `trisula_hist_${process.pid}`;
const ANNA = 'u1';
const BOB = 'u2';
const BOSS = 'u3';
const CO = 'c1';
const KEY = 'forensics-review';

const anna = { userId: ANNA, isAdmin: false };
const bob = { userId: BOB, isAdmin: false };
const boss = { userId: BOSS, isAdmin: true };

let n = 0;
const asked = (by: string | null, key = KEY, extra: Record<string, string> = {}) =>
  serviceTxn('system:agents', (c) =>
    c.query(
      `INSERT INTO agent_runs (id, agent_key, company_id, requested_by, subject_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [`r${n++}`, key, CO, by, extra['subject'] ?? null, extra['status'] ?? 'queued'],
    ));

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    for (const [id, email] of [[ANNA, 'anna@x.com'], [BOB, 'bob@x.com'], [BOSS, 'boss@x.com']]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, email]);
      await c.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$2)', [id, email]);
    }
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega')", [CO]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    // Drafts before runs: ai_drafts.run_id references agent_runs and the foreign key refuses to
    // let a run go while a draft still points at it.
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

test('a person sees their own requests and nobody else’s', async () => {
  await asked(ANNA);
  await asked(BOB);

  const mine = await askedRuns(anna, KEY);
  assert.equal(mine.length, 1, 'one row, not two');
  assert.equal(mine[0]?.askedBy, 'anna@x.com');
  assert.equal(mine[0]?.askedByMe, true);

  // The half that matters: Bob's request is not merely unlabelled, it is absent.
  assert.deepEqual((await askedRuns(bob, KEY)).map((r) => r.askedBy), ['bob@x.com']);
});

test('an admin sees everybody’s, and which are their own', async () => {
  await asked(ANNA);
  await asked(BOB);
  await asked(BOSS);

  const all = await askedRuns(boss, KEY);
  assert.deepEqual(all.map((r) => r.askedBy).sort(), ['anna@x.com', 'bob@x.com', 'boss@x.com']);
  assert.deepEqual(all.filter((r) => r.askedByMe).map((r) => r.askedBy), ['boss@x.com']);
});

test('a sweep run is not history, for anybody', async () => {
  // 79 of 88 rows on the database this was written against were sweep-enqueued. They are the
  // registry's subject, not a record of somebody asking, and `/agents` is where they belong.
  await asked(null);
  assert.deepEqual(await askedRuns(anna, KEY), []);
  assert.deepEqual(await askedRuns(boss, KEY), [], 'not even for an admin');
});

test('the history is per agent, not one list of everything', async () => {
  await asked(ANNA, 'forensics-review');
  await asked(ANNA, 'news-brief');
  assert.equal((await askedRuns(anna, 'forensics-review')).length, 1);
  assert.equal((await askedRuns(anna, 'news-brief')).length, 1);
});

test('the counts obey the same rule as the rows', async () => {
  // Two ways of asking one question. A count that leaked what the list hides would put "3 requests"
  // on a card whose page then shows one.
  await asked(ANNA);
  await asked(BOB);
  await asked(BOB, 'news-brief');
  await asked(null);

  assert.deepEqual(await askedCounts(anna), { 'forensics-review': 1 });
  assert.deepEqual(await askedCounts(bob), { 'forensics-review': 1, 'news-brief': 1 });
  assert.deepEqual(await askedCounts(boss), { 'forensics-review': 2, 'news-brief': 1 });
});

test('a request says what it was pointed at, and where it ended up', async () => {
  // The point of a history is that it closes. "done" is not an answer; the draft is.
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind)
       VALUES ('f1',$1,'consolidated','2024-04-01','2025-03-31','year')`, [CO]);
    await c.query(
      `INSERT INTO agent_runs (id, agent_key, company_id, requested_by, subject_ref, status)
       VALUES ('rx','results-figures',$1,$2,'f1','done')`, [CO, ANNA]);
    await c.query(
      `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, sources, model, status)
       VALUES ('d1','rx','results-figures',$1,'{}'::jsonb,'[]'::jsonb,'m','pending')`, [CO]);
  });

  const [row] = await askedRuns(anna, 'results-figures');
  assert.equal(row?.companySymbol, 'TEGA');
  assert.match(String(row?.subjectLabel), /year to 2025-03-31/, 'the label the picker showed');
  assert.equal(row?.draftStatus, 'pending', 'so the page can link it to the review queue');
  assert.equal(row?.documentId, null, 'nothing accepted it yet');
});

test('a subject that has since been deleted still shows the request that named it', async () => {
  // LEFT JOIN, deliberately: a superseded period or an archived transcript does not unmake the fact
  // that somebody asked about it.
  await asked(ANNA, 'results-figures', { subject: 'gone-for-good' });
  const [row] = await askedRuns(anna, 'results-figures');
  assert.ok(row, 'the request survives its subject');
  assert.equal(row?.subjectLabel, null);
});
