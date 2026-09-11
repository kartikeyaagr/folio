/**
 * The prompt an agent is actually given, and what the exemplar block costs to give it.
 *
 * `tasks/todo.md` makes that cost a shipping condition — *"measure prompt tokens per agent run with
 * and without it, on the same questions, and record the number in the file"* — so it is asserted
 * here rather than printed by a script nobody runs. Characters, not Claude tokens: counting those
 * needs Claude, and `ops/measure-exemplar-cost.ts` prints the real figure when a credential exists.
 *
 * The embedder is the local ONNX one, so this costs nothing and needs no key.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, serviceTxn } from '../db.ts';
import { embedPending, retrieveExemplars, MAX_EXEMPLARS } from './exemplars.ts';
import { EXEMPLAR_PREAMBLE, exemplarCost, systemFor } from './prompt.ts';
import type { AgentRow } from './runner.ts';

const DB = `trisula_prompt_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

const PURPOSE = 'Summarise an earnings call and say how guidance has changed since the last one.';

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  key: 'concall-insights', label: 'Shruti', purpose: PURPOSE, model: 'claude-opus-5',
  effort: 'xhigh', data_scope: [], tools: [], learning: true, notify_on_draft: false, ...over,
});

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [CO]);
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

/** An exemplar in the corpus, unembedded, as acceptance leaves it. */
async function seed(
  situation: string,
  output: Record<string, unknown> = { headline: 'Guidance held at eighteen percent' },
  agentKey = 'concall-insights',
): Promise<void> {
  await serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_runs (id, agent_key, company_id)
       VALUES (md5(random()::text), $1, $2) RETURNING id`,
      [agentKey, CO],
    );
    const { rows: d } = await c.query<{ id: string }>(
      `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, model, situation)
       VALUES (md5(random()::text), $1, $2, $3, '{}'::jsonb, 'claude-opus-5', $4) RETURNING id`,
      [rows[0]!.id, agentKey, CO, situation],
    );
    await c.query(
      `INSERT INTO exemplars (id, agent_id, draft_id, situation, output, quality)
       VALUES (md5(random()::text), $1, $2, $3, $4, 'accepted')`,
      [agentKey, d[0]!.id, situation, JSON.stringify(output)],
    );
  });
}

// ---- the queue ----------------------------------------------------------------------------------

test('the indexer embeds what acceptance left unembedded, and then finds nothing', async () => {
  await seed('Earnings call transcript, 41k characters, previous call held for comparison');
  assert.equal(await embedPending(), 1);
  // House rule 3's shape: the queue is "what has no embedding yet", so a second run is a quiet day
  // rather than the same row again.
  assert.equal(await embedPending(), 0);
});

test('an exemplar embedded under a superseded model is quarantined, not compared across spaces', async () => {
  // Vectors from two models occupy different spaces and comparing them returns plausible numbers
  // with meaningless neighbours — the failure with no symptom. search.ts filters embed_model for
  // exactly this reason and so does retrieval here.
  await seed('Earnings call transcript, 41k characters, previous call held for comparison');
  await embedPending();
  await serviceTxn('system:index', async (c) => {
    await c.query("UPDATE exemplars SET embed_model = 'bge-small-en-v0.9'");
  });
  assert.deepEqual(await retrieveExemplars('concall-insights', 'an earnings call'), []);
});

test('retrieval is scoped to the agent, and capped at three', async () => {
  for (let i = 0; i < 5; i++) await seed(`Earnings call transcript, ${i}0k characters`);
  await seed('7-day desk brief across 3 followed names', { headline: 'x' }, 'news-brief');
  await embedPending();

  const mine = await retrieveExemplars('concall-insights', 'Earnings call transcript, 40k characters');
  assert.equal(mine.length, MAX_EXEMPLARS);
  const theirs = await retrieveExemplars('news-brief', 'a brief');
  assert.equal(theirs.length, 1, "another agent's work is not an example for this one");
});

// ---- the prompt ---------------------------------------------------------------------------------

test('an agent that does not learn gets its purpose, byte for byte', async () => {
  // §7 gates retrieval on the flag, not capture — so a corpus can exist for an agent that reads
  // none of it, and turning the flag on later starts from that corpus rather than from zero.
  await seed('Earnings call transcript, 41k characters');
  await embedPending();
  assert.equal(await systemFor(agent({ learning: false }), 'an earnings call'), PURPOSE);
});

test('a learning agent with an empty corpus also gets its purpose, with no empty heading', async () => {
  // Every run for the first few weeks. A preamble with nothing under it reads as a mistake.
  assert.equal(await systemFor(agent(), 'an earnings call'), PURPOSE);
});

test('the blocks are in §7’s order: purpose, then the examples', async () => {
  await seed('Earnings call transcript, 41k characters, previous call held for comparison');
  await embedPending();
  const prompt = await systemFor(agent(), 'Earnings call transcript, 38k characters');

  assert.ok(prompt.startsWith(PURPOSE), 'purpose first — R6 inserts approved rules below it');
  assert.ok(prompt.includes(EXEMPLAR_PREAMBLE));
  assert.ok(prompt.indexOf(PURPOSE) < prompt.indexOf(EXEMPLAR_PREAMBLE), 'ordered by authority');
  assert.match(prompt, /Guidance held at eighteen percent/, 'and the signed-off output is shown');
  assert.match(prompt, /never carry a figure across from an example/);
});

test('an example corrected by an analyst says so, because it is different evidence', async () => {
  await seed('Earnings call transcript, 41k characters');
  await embedPending();
  await serviceTxn('system:agents', async (c) => {
    await c.query("UPDATE exemplars SET quality = 'edited'");
  });
  const prompt = await systemFor(agent(), 'an earnings call');
  assert.match(prompt, /corrected by an analyst before acceptance/);
});

// ---- what it costs ------------------------------------------------------------------------------

test('the exemplar block costs what it costs, and the number is asserted rather than described', async () => {
  // tasks/todo.md, ground rule 5: "measure prompt tokens per agent run with and without it, on the
  // same questions, and record the number in the file." Exemplar retrieval can only ADD to a
  // prompt — the "shrink prompts" half of that rule was written about content retrieval, which R3
  // delivered. What this asserts is that the cost is bounded and known, not that it is zero.
  await seed(
    'Earnings call transcript, 41k characters, previous call held for comparison',
    { headline: 'Guidance held at eighteen percent', guidance_delta: 'Unchanged from the prior quarter.' },
  );
  await embedPending();

  const situation = 'Earnings call transcript, 38k characters, previous call held for comparison';
  const cost = await exemplarCost(agent(), situation);

  assert.ok(cost > 0, 'one example is not free');
  // A loose ceiling, deliberately: this is a regression guard against an accidental change that
  // starts embedding whole drafts into every prompt, not a claim about the exact size.
  assert.ok(cost < 4000, `one example should not dominate a prompt, got ${cost} characters`);
  assert.equal(await exemplarCost(agent({ learning: false }), situation), 0, 'and nothing when off');
});
