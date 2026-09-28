/**
 * The brief arrives at eight: scheduled, published without review, and mailed to everybody.
 *
 * The fund's decision of 28-Sep-2026 (migration 0067) makes agent 6 the one exception to the review
 * gate and to the one-envelope digest. So what is tested here is that each exception is exactly as
 * wide as decided and no wider: one scheduled brief an IST day, from eight; a brief somebody asks
 * for that neither stands in for it nor doubles it; publication for this agent and no other; and
 * a mail to every active user that is recorded as sent, or fails where somebody will see it.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { readTxn, serviceTxn } from '../db.ts';
import { ASKABLE_DAYS, briefInFlight } from '../briefs.ts';
import { drainOutbox, noRelay, type Mail } from '../notify.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { drain, registerHandler } from './runner.ts';
import { enqueue } from './queue.ts';
import { weeklyDistance } from './learning.ts';
import { pendingDrafts, publishDraft } from './review.ts';
import * as newsbrief from './newsbrief.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_brief_${process.pid}`;
const ANNA = 'u1';
const BOB = 'u2';
const GONE = 'u3';
const CO = 'c1';

/** An IST wall-clock time as an instant. 28-Sep-2026 is a Monday. */
const ist = (hhmm: string, day = '2026-09-28'): Date => new Date(`${day}T${hhmm}:00+05:30`);

const BRIEF = {
  period: 'The last 24 hours',
  by_company: [{ symbol: 'TEGA', what_happened: ['The CFO resigned.'], why_it_matters: 'Watch it.' }],
  nothing_to_report: ['AERON'],
  coming_up: ['TEGA — results, 30 September'],
};

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    for (const [id, email, name] of [
      [ANNA, 'anna@example.com', 'Anna'],
      [BOB, 'bob@example.com', 'Bob'],
      [GONE, 'gone@example.com', 'Gone'],
    ]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, name]);
      await c.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [id, email, name]);
    }
    await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [GONE]);
    // `watching`, so the gather has a name to brief on: with none it throws, and every test below
    // would fail for a reason that has nothing to do with it.
    await c.query(
      "INSERT INTO companies (id,symbol,name,status) VALUES ($1,'TEGA','Tega Industries','watching')",
      [CO],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM notification_outbox');
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
    await c.query('DELETE FROM filings');
  });
});

const runs = () =>
  readTxn(async (c) => {
    const { rows } = await c.query<{
      subject_ref: string | null; request: Record<string, unknown>; requested_by: string | null;
    }>(
      `SELECT subject_ref, request, requested_by FROM agent_runs
        WHERE agent_key = 'news-brief' ORDER BY subject_ref NULLS LAST, created_at`,
    );
    return rows;
  });

const outbox = () =>
  readTxn(async (c) => {
    const { rows } = await c.query<{
      recipient: string; kind: string; sent_at: Date | null; attempts: number; last_error: string | null;
    }>(
      'SELECT recipient, kind, sent_at, attempts, last_error FROM notification_outbox ORDER BY recipient',
    );
    return rows;
  });

// ---- the schedule -------------------------------------------------------------------------------

test('the day’s brief is queued once an IST day, from eight and never before', async () => {
  assert.equal(await newsbrief.sweep(ist('07:59')), 0, 'not before eight');
  assert.equal(await newsbrief.sweep(ist('08:00')), 1, 'at eight');
  assert.equal(await newsbrief.sweep(ist('08:05')), 0, 'and not again on the next pass');
  assert.equal(await newsbrief.sweep(ist('23:55')), 0, 'or at any hour after it that day');
  assert.equal(await newsbrief.sweep(ist('07:59', '2026-09-29')), 0, 'tomorrow waits for eight too');
  assert.equal(await newsbrief.sweep(ist('08:05', '2026-09-29')), 1, 'and then has its own');

  const queued = await runs();
  assert.deepEqual(queued.map((r) => r.subject_ref), ['2026-09-28', '2026-09-29'], 'keyed on the IST day');
  assert.deepEqual(queued[0]!.request, { days: 1 }, 'covering the last 24 hours');
  assert.equal(queued[0]!.requested_by, null, 'and asked for by nobody');
});

test('a second brief for the same day is refused by the database, however it is queued', async () => {
  // What holds "once" when two sweeps race, which NOT EXISTS alone cannot: both would see nothing.
  const insert = (id: string) =>
    serviceTxn('system:agents', (c) =>
      c.query(
        "INSERT INTO agent_runs (id, agent_key, subject_ref) VALUES ($1, 'news-brief', '2026-09-28')",
        [id]));
  await insert('r1');
  await assert.rejects(insert('r2'), /agent_runs_one_brief_a_day/);
  // A brief a person asks for has no day, so any number of them may exist.
  await enqueue({ agentKey: 'news-brief', requestedBy: ANNA, request: { days: 7 } });
  await enqueue({ agentKey: 'news-brief', requestedBy: BOB, request: { days: 7 } });
  assert.equal((await runs()).length, 3);
});

test('a brief somebody asks for neither stands in for the day’s brief nor adds a second', async () => {
  // Asked for at 07:30, or at 08:02 before the timer's first pass after eight.
  await enqueue({ agentKey: 'news-brief', requestedBy: ANNA, request: { days: 7 } });
  assert.equal(await newsbrief.sweep(ist('08:05')), 1, 'the day’s brief is still owed');

  // Asked for after the day's was queued, and after it was written.
  await enqueue({ agentKey: 'news-brief', requestedBy: BOB, request: { days: 14 } });
  assert.equal(await newsbrief.sweep(ist('08:10')), 0, 'and there is still only one of it');

  const all = await runs();
  assert.equal(all.filter((r) => r.subject_ref !== null).length, 1);
  assert.equal(all.filter((r) => r.requested_by !== null).length, 2, 'both requests still stand');
  assert.equal(await briefInFlight(), true, 'and a third request is refused while these wait');
  assert.ok(
    !ASKABLE_DAYS.includes(newsbrief.SCHEDULED_DAYS),
    'nor is one ever a copy of it: nobody can ask for the window the morning’s already covers',
  );
});

test('a disabled brief agent is not queued, so a switched-off agent stays off', async () => {
  await serviceTxn('system:agents', (c) =>
    c.query("UPDATE agents SET enabled = false WHERE key = 'news-brief'"));
  try {
    assert.equal(await newsbrief.sweep(ist('08:05')), 0);
  } finally {
    await serviceTxn('system:agents', (c) =>
      c.query("UPDATE agents SET enabled = true WHERE key = 'news-brief'"));
  }
});

test('the day’s brief covers the last 24 hours, and one asked for covers the window chosen', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at) VALUES
         ('f1',$1,'TEGA','Resignation','A fresh filing', now() - interval '1 hour'),
         ('f2',$1,'TEGA','Board meeting','An older filing', now() - interval '3 days')`, [CO]);
  });
  await newsbrief.sweep(ist('08:05'));
  const scheduled = scriptedModel([scriptedOk(BRIEF)]);
  await drain(1, scheduled);
  const today = scheduled.calls[0]!.task;
  assert.match(today, /The last 24 hours/);
  assert.match(today, /A fresh filing/);
  assert.doesNotMatch(today, /An older filing/, 'three days ago is not the last 24 hours');

  await enqueue({ agentKey: 'news-brief', requestedBy: ANNA, request: { days: 14 } });
  const asked = scriptedModel([scriptedOk(BRIEF)]);
  await drain(1, asked);
  assert.match(asked.calls[0]!.task, /The last 14 days/);
  assert.match(asked.calls[0]!.task, /An older filing/);
});

// ---- publishing without review ------------------------------------------------------------------

test('the brief lands without review, written by the agents, and keeps where it came from', async () => {
  await newsbrief.sweep(ist('08:05'));
  const r = await drain(1, scriptedModel([scriptedOk(BRIEF)]));
  assert.equal(r.drafted, 1);
  assert.deepEqual(await pendingDrafts(), [], 'nothing waits in Review');

  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{
      kind: string; created_by: string; written_by: string; status: string;
      decided_by: string | null; decided_at: Date | null; edits: unknown; edit_distance: string | null;
      model: string; cost_usd: string | null; run_status: string; run_draft: string; draft_id: string;
    }>(
      `SELECT d.kind, d.created_by, v.written_by, dr.status, dr.decided_by, dr.decided_at, dr.edits,
              dr.edit_distance, dr.model, dr.cost_usd::text AS cost_usd, dr.id AS draft_id,
              r.status AS run_status, r.draft_id AS run_draft
         FROM documents d
         JOIN document_versions v ON v.document_id = d.id
         JOIN ai_drafts dr ON dr.id = d.from_draft_id
         JOIN agent_runs r ON r.id = dr.run_id`,
    );
    assert.equal(rows.length, 1, 'one brief, one document');
    return rows[0]!;
  });
  assert.equal(row.kind, 'brief');
  assert.equal(row.created_by, 'system:agents', 'a job wrote it, and it does not borrow a name');
  assert.equal(row.written_by, 'system:agents');
  assert.equal(row.status, 'published', 'the draft says it was published, not accepted');
  assert.equal(row.decided_by, null, 'and that nobody decided it');
  assert.ok(row.decided_at, 'but when it went out');
  assert.equal(row.edits, null);
  assert.equal(row.edit_distance, null, 'no distance: a zero would claim somebody read it');
  assert.equal(row.model, 'claude-opus-5');
  assert.ok(Number(row.cost_usd) > 0, 'what it cost is recorded, and it is not a zero');
  assert.equal(row.run_status, 'done');
  assert.equal(row.run_draft, row.draft_id, 'the run, the draft and the document are one chain');

  const exemplars = await readTxn((c) => c.query('SELECT 1 FROM exemplars'));
  assert.equal(exemplars.rowCount, 0, 'and it teaches the agent nothing: nobody signed it off');
  assert.deepEqual(
    (await weeklyDistance()).filter((w) => w.agentKey === 'news-brief'), [],
    '/agents gets no week of 0 accepted, 0 edited, 0 rejected for an agent nobody reviews',
  );

  // Published means nobody decided, and the database keeps it that way.
  await assert.rejects(
    serviceTxn('system:agents', (c) =>
      c.query('UPDATE ai_drafts SET decided_by = $1 WHERE id = $2', [ANNA, row.draft_id])),
    /nobody_signed_a_published_draft/,
  );
});

test('no other agent skips review, in the code or in the database', async () => {
  registerHandler('concall-insights', async () => ({
    draft: { content: { summary: 'A call.' }, situation: 'a call', sources: [], model: 'claude-opus-5' },
  }));
  await enqueue({ agentKey: 'concall-insights', companyId: CO, requestedBy: ANNA });
  await drain(1, scriptedModel([]));

  const [waiting] = await pendingDrafts();
  assert.equal(waiting?.agentKey, 'concall-insights', 'agent 2’s draft waits for a person');
  const docs = await readTxn((c) => c.query('SELECT 1 FROM documents'));
  assert.equal(docs.rowCount, 0, 'and nothing reached the record');

  // However the row is reached. `only_the_brief_skips_review` (0067) is the database's copy of
  // PUBLISHED_WITHOUT_REVIEW, and a caller that went round the runner meets it.
  await assert.rejects(
    serviceTxn('system:agents', (c) => publishDraft(c, waiting!.id)),
    /only_the_brief_skips_review/,
  );
  assert.equal((await pendingDrafts()).length, 1, 'still waiting');
});

// ---- the mail -----------------------------------------------------------------------------------

async function written(): Promise<void> {
  await newsbrief.sweep(ist('08:05'));
  await drain(1, scriptedModel([scriptedOk(BRIEF)]));
}

test('the brief is mailed to every active user, and each send is recorded as sent', async () => {
  await written();
  const queued = await outbox();
  assert.deepEqual(queued.map((o) => o.recipient), [ANNA, BOB], 'queued with the brief, not for Gone');
  assert.ok(queued.every((o) => o.kind === 'brief' && o.sent_at === null));

  const sent: Mail[] = [];
  const r = await drainOutbox(async (m) => { sent.push(m); }, 50, 'brief');
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['anna@example.com', 'bob@example.com']);
  assert.match(sent[0]!.subject, /^Folio brief — .*: 1 name, 1 quiet$/);
  assert.match(sent[0]!.body, /The CFO resigned\./, 'the brief itself, not a link to it');
  assert.match(sent[0]!.body, /not reviewed/);

  assert.ok((await outbox()).every((o) => o.sent_at !== null), 'stamped, so the digest never resends it');
  assert.equal((await drainOutbox(async (m) => { sent.push(m); }, 50, 'brief')).sent, 0, 'or twice');
});

test('a missing relay fails the send and keeps the reason, rather than queueing quietly', async () => {
  await written();
  const r = await drainOutbox(noRelay, 50, 'brief');
  assert.equal(r.failed, 2, 'one failure per person, which is what fails the agents job');
  assert.match(String(r.lastError), /no SMTP relay is configured/);
  for (const o of await outbox()) {
    assert.equal(o.sent_at, null);
    assert.equal(o.attempts, 1, 'an attempt is spent, so it stops after MAX_SEND_ATTEMPTS');
    assert.match(String(o.last_error), /no SMTP relay/);
  }
});

test('only the brief’s mail is sent on its own; everything else waits for the digest', async () => {
  await written();
  await serviceTxn('system:alerts', (c) =>
    c.query(
      `INSERT INTO notification_outbox (id, kind, recipient, subject, body)
       VALUES ('a1', 'alert', $1, 'TEGA fell 9%', 'the body')`, [ANNA]));

  const sent: Mail[] = [];
  await drainOutbox(async (m) => { sent.push(m); }, 50, 'brief');
  assert.ok(sent.every((m) => m.subject.startsWith('Folio brief')));
  const alert = (await outbox()).find((o) => o.kind === 'alert');
  assert.equal(alert?.sent_at, null, 'the alert rides tomorrow’s digest, as it always did');
});
