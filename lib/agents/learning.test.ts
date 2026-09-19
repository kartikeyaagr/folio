/**
 * That accepting a draft records how far it was changed, and keeps what was signed off.
 *
 * The thing under test is the one §7 stakes the loop on. Before R5a `acceptDraft` was only ever
 * called with `null`, so `edits` was always `{}` and mean edit distance was pinned at 0.000 for
 * every agent — a number that reads as "the agents are perfect" and meant "nobody can correct
 * them". These assert that it can now move, and that a zero means what it says.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { drain, registerHandler } from './runner.ts';
import { enqueue } from './queue.ts';
import { acceptDraft, pendingDrafts, rejectDraft } from './review.ts';
import { coverage, fieldHotspots, weeklyDistance } from './learning.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_learn_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query(
      "INSERT INTO companies (id,symbol,name,sector) VALUES ($1,'PRAJIND','Praj','Industrials')",
      [CO],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

const HEADLINE = 'Revenue rose on a larger order book and a better mix of engineering work';

/** One draft from a real run, through the real runner, waiting in the queue. */
async function aDraft(content: Record<string, unknown> = { headline: HEADLINE }) {
  registerHandler('news-brief', async (ctx) => {
    const a = await ctx.ask({ model: ctx.agent.model, system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('unexpected');
    return {
      draft: {
        content: a.content,
        situation: '7-day desk brief across 3 followed names: 4 filings, 2 news items, 0 alerts',
        sources: [{ kind: 'company', ref: 'PRAJIND' }],
        model: a.model, costUsd: a.costUsd,
      },
    };
  });
  await enqueue({ agentKey: 'news-brief', companyId: CO });
  await drain(1, scriptedModel([scriptedOk(content)]));
  const [d] = await pendingDrafts();
  assert.ok(d, 'a draft was written');
  return d;
}

const exemplars = () =>
  readTxn(async (c) => {
    const { rows } = await c.query<{
      agent_id: string; situation: string; quality: string; vertical: string | null;
      embedding: unknown; output: Record<string, unknown>;
    }>('SELECT agent_id, situation, quality, vertical, embedding, output FROM exemplars');
    return rows;
  });

const draftRow = (id: string) =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ edits: Record<string, unknown>; edit_distance: string | null }>(
      'SELECT edits, edit_distance FROM ai_drafts WHERE id = $1', [id],
    );
    return rows[0]!;
  });

test('accepting with a correction records which field moved, and how far', async () => {
  const d = await aDraft();
  await acceptDraft(d.id, { edits: { headline: 'Revenue rose on a larger order book and a richer mix of engineering work' } }, ME);

  const row = await draftRow(d.id);
  assert.ok('headline' in row.edits, 'the edited field is named');
  const distance = Number(row.edit_distance);
  assert.ok(distance > 0 && distance < 1, `one word in thirteen, got ${distance}`);
});

test('a corrected draft becomes an exemplar of what was signed off, not of what the model said', async () => {
  const d = await aDraft();
  const corrected = 'Revenue rose on a larger order book and a richer mix of engineering work';
  await acceptDraft(d.id, { edits: { headline: corrected } }, ME);

  const [e] = await exemplars();
  assert.ok(e);
  assert.equal(e.agent_id, 'news-brief');
  assert.equal(e.quality, 'edited');
  assert.equal(e.output['headline'], corrected, 'the exemplar holds the signed-off text');
  assert.match(e.situation, /7-day desk brief/, 'the situation is the agent’s, describing its inputs');
  assert.equal(e.vertical, 'Industrials', 'the sector, for a like-for-like match later');
  // §7: "The embedding does not" run inside the acceptance transaction — an analyst clicking accept
  // must not wait on a model load, and a failure there must not cost them the acceptance.
  assert.equal(e.embedding, null, 'the indexer embeds it later; the queue is the null');
});

test('accepting unchanged still writes an exemplar, and its distance is a real zero', async () => {
  // §7 keeps this quirk on purpose: the learning flag gates retrieval, not capture, so turning it
  // on for an agent later finds a corpus already waiting rather than starting from zero.
  const d = await aDraft();
  await acceptDraft(d.id, null, ME);

  const row = await draftRow(d.id);
  assert.equal(Number(row.edit_distance), 0);
  assert.deepEqual(row.edits, {});

  const [e] = await exemplars();
  assert.equal(e?.quality, 'accepted', 'signed off untouched is different evidence from corrected');
});

test('a rejection is not an exemplar', async () => {
  // "A rejection says what was wrong without ever saying what right would have looked like."
  const d = await aDraft();
  await rejectDraft(d.id, 'the order book figure is from the wrong quarter', ME);
  assert.deepEqual(await exemplars(), []);
});

test('what a person changes is merged over the draft, never a replacement', async () => {
  // /review can only edit string fields, so a patch that replaced the whole object would drop
  // every array the agent wrote. The merge happens under the row lock in acceptDraft.
  const d = await aDraft({ headline: HEADLINE, by_company: [{ symbol: 'PRAJIND' }] });
  await acceptDraft(d.id, { edits: { headline: 'A corrected headline that is long enough to be prose' } }, ME);

  const [e] = await exemplars();
  assert.deepEqual(e?.output['by_company'], [{ symbol: 'PRAJIND' }], 'the untouched array survived');
  assert.equal(e?.output['headline'], 'A corrected headline that is long enough to be prose');
});

// ---- the evidence on /agents --------------------------------------------------------------------

test('coverage reports held and retrievable separately, and skips agents with no model', async () => {
  const d = await aDraft();
  await acceptDraft(d.id, null, ME);

  const rows = await coverage();
  const brief = rows.find((r) => r.agentKey === 'news-brief')!;
  assert.equal(brief.held, 1);
  assert.equal(brief.retrievable, 0, 'nothing is embedded until R5b, so nothing is retrievable');
  assert.equal(brief.learning, true);

  assert.ok(!rows.some((r) => r.model === 'none'), 'agents 4 and 5 call no model and cannot learn');
  const ganak = rows.find((r) => r.agentKey === 'results-figures')!;
  assert.equal(ganak.learning, false, 'agent 1 has a verifier, which is a better teacher');
});

test('the weekly view counts an edit only when something actually moved', async () => {
  const a = await aDraft();
  await acceptDraft(a.id, null, ME);
  const b = await aDraft();
  await acceptDraft(b.id, { edits: { headline: `${HEADLINE} and a better order intake` } }, ME);
  const c = await aDraft();
  await rejectDraft(c.id, 'wrong period', ME);

  const [week] = await weeklyDistance();
  assert.ok(week);
  assert.equal(week.accepted, 2);
  assert.equal(week.edited, 1, 'one of the two accepted was actually changed');
  assert.equal(week.rejected, 1);
  assert.ok(week.meanDistance !== null && week.meanDistance > 0);
});

test('the hotspot view names the field, which is what a rule gets written about', async () => {
  for (let i = 0; i < 2; i++) {
    const d = await aDraft();
    await acceptDraft(d.id, { edits: { headline: `${HEADLINE} — corrected ${i}` } }, ME);
  }
  const hot = await fieldHotspots();
  assert.deepEqual(hot, [{ agentKey: 'news-brief', field: 'headline', corrections: 2 }]);
});

test('a field corrected at two positions is one hotspot, not two of one', async () => {
  // `edits` is keyed by path now, so `by_company[0].why_it_matters` and `by_company[1]....` are the
  // same field seen twice. Grouped raw they would each read as a single correction, and with a
  // LIMIT on the query the repeats would push every other agent's hotspots off the screen.
  //
  // The grouping has to be spelled out as `GROUP BY agent_key, edit_field(field)`: Postgres
  // resolves a bare `field` in GROUP BY to the input column rather than to the same-named alias,
  // so `GROUP BY agent_key, field` compiles, runs, and quietly groups by the raw path.
  const co = (symbol: string) => ({ symbol, what_happened: ['A filing.'], why_it_matters: 'Quiet.' });
  const d = await aDraft({
    period: 'The last 7 days',
    by_company: [co('PRAJIND'), co('AERON')],
    nothing_to_report: [],
    coming_up: [],
  });
  await acceptDraft(
    d.id,
    {
      edits: {
        'by_company[0].why_it_matters': 'A rewritten judgement about the first name.',
        'by_company[1].why_it_matters': 'A rewritten judgement about the second name.',
      },
    },
    ME,
  );

  const hot = await fieldHotspots();
  assert.deepEqual(hot, [
    { agentKey: 'news-brief', field: 'by_company[].why_it_matters', corrections: 2 },
  ]);
});
