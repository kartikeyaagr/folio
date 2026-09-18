/**
 * What the request desk offers, against what the sweeps would have offered.
 *
 * `subjects.ts` duplicates two sweep predicates so a page can render a picker without importing a
 * handler module — and with it the 130 MB embedder. Duplication is the trade; these are what stop
 * it drifting. A picker that offered a superseded period, a short transcript, or another company's
 * row would enqueue a run that claims, throws, retries twice and lands under "Failed runs" as
 * something nobody meant to ask for.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { migrate } from '../../db/migrate.ts';
import { closePool, serviceTxn } from '../db.ts';
import { MIN_TRANSCRIPT_CHARS as CONCALL_FLOOR } from './concall.ts';
import { isSubjectFor, MIN_TRANSCRIPT_CHARS, subjectsFor } from './subjects.ts';

const DB = `trisula_subj_${process.pid}`;
const ME = 'p1';
const A = 'c1';
const B = 'c2';
const CRORE = 10_000_000;

const transcript = (id: string, company: string, chars: number, title = 'Q1 call') =>
  serviceTxn('system:auth', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ($1,$2,$3,'transcript',$4)`,
      [id, company, title, ME]);
    await c.query('INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
      [id, JSON.stringify({ text: 'x'.repeat(chars) }), ME]);
  });

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'AAA','Alpha')", [A]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'BBB','Beta')", [B]);
    // A live annual, a superseded one, and one belonging to the other company.
    for (const [id, co, sup] of [['live', A, null], ['old', A, 'live'], ['theirs', B, null]] as const) {
      await c.query(
        `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind,
                                   revenue, profit_after_tax, superseded_by)
         VALUES ($1,$2,'consolidated','2024-04-01','2025-03-31','year',$3,$4,$5)`,
        [id, co, 900 * CRORE, 60 * CRORE, sup]);
    }
  });
  await transcript('long', A, CONCALL_FLOOR + 10, 'A real call');
  await transcript('short', A, 50, 'A paste that went wrong');
  await transcript('theirs-t', B, CONCALL_FLOOR + 10);
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

const refs = async (key: string, co: string | null): Promise<string[]> =>
  (await subjectsFor(key, co)).map((s) => s.ref).sort();

test('the floor here is the floor the handler refuses below', () => {
  // Duplicated as a number so a page can render a picker without dragging `concall.ts` — and with
  // it `prompt.ts` → `exemplars.ts` → the embedder — into the web build. This is what makes the
  // duplication safe rather than a second source of truth.
  assert.equal(MIN_TRANSCRIPT_CHARS, CONCALL_FLOOR);
});

test('a superseded period is never offered, because agent 1 would not read it', async () => {
  assert.deepEqual(await refs('results-figures', A), ['live']);
});

test('a transcript below the floor is never offered, because the handler refuses it after claiming', async () => {
  assert.deepEqual(await refs('concall-insights', A), ['long']);
});

test('another company’s subjects are never offered', async () => {
  assert.ok(!(await refs('results-figures', A)).includes('theirs'));
  assert.ok(!(await refs('concall-insights', A)).includes('theirs-t'));
  assert.deepEqual(await refs('results-figures', B), ['theirs']);
});

test('agents that need no picker offer none, and neither does a page with no company', async () => {
  assert.deepEqual(await subjectsFor('forensics-review', A), [], 'the company IS the subject');
  assert.deepEqual(await subjectsFor('news-brief', A), [], 'reads the whole followed universe');
  assert.deepEqual(await subjectsFor('results-figures', null), [], 'nothing to list without a company');
  assert.deepEqual(await subjectsFor('email-workflow', A), [], 'not askable at all');
});

test('a subject already read is offered anyway, and labelled', async () => {
  // The sweeps skip these because they must not spend money twice unasked. A person asking again
  // has asked on purpose, and hiding it would leave them no way to say "read that again".
  const { enqueue } = await import('./queue.ts');
  await enqueue({ agentKey: 'results-figures', subjectRef: 'live', companyId: A });

  const [only] = await subjectsFor('results-figures', A);
  assert.equal(only?.ref, 'live', 'still offered');
  assert.equal(only?.alreadyRead, true, 'and said so');
});

test('isSubjectFor is the action’s check, and it refuses what the picker would not have shown', async () => {
  // A `<select>` is a suggestion; the value posted back is whatever the browser sent.
  assert.equal(await isSubjectFor('results-figures', A, 'live'), true);
  assert.equal(await isSubjectFor('results-figures', A, 'old'), false, 'superseded');
  assert.equal(await isSubjectFor('results-figures', A, 'theirs'), false, 'another company');
  assert.equal(await isSubjectFor('concall-insights', A, 'short'), false, 'below the floor');
  assert.equal(await isSubjectFor('concall-insights', A, 'long'), true);
});
