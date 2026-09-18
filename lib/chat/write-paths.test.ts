/**
 * R4 — the two paths out of a thread, and the gate they both land in.
 *
 * `v4.md §6.3`: *"Nothing, directly. Two paths out of a thread, both landing in the existing
 * gate."* The tests that matter here are the ones asserting a draft is **pending** and becomes a
 * document only through `acceptDraft` — the agent never writes the record, a person does.
 *
 * The scripted model calls the tools it is handed, so `draft_document` and `run_agent` run their
 * real SQL against a real database. No network.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { enqueue } from '../agents/queue.ts';
import { acceptDraft, pendingDrafts } from '../agents/review.ts';
import { INVOCABLE_KEYS } from '../agents/tools/queue-run.ts';
import type { ToolModel } from '../agents/loop.ts';
import { startThread, threadWithMessages } from './threads.ts';
import { takeTurn } from './turn.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_wp_${process.pid}`;
const ME = 'p1';
const CO = 'c1';
const CRORE = 10_000_000;

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj Industries')", [CO]);
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind,
                                 revenue, profit_after_tax)
       VALUES ('q1',$1,'consolidated','2024-10-01','2024-12-31','quarter',$2,$3)`,
      [CO, 219.1 * CRORE, 1.28 * CRORE],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    // Documents before drafts before runs: each foreign key refuses to let the next go.
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM chat_tool_calls');
    await c.query('DELETE FROM chat_messages');
    await c.query('DELETE FROM chat_threads');
    await c.query('DELETE FROM agent_runs');
  });
});

/** A turn the way production takes one: a real queued run, because ai_drafts.run_id is NOT NULL. */
async function turn(threadId: string, ask: ToolModel) {
  const runId = await enqueue({ agentKey: 'desk-analyst', subjectRef: threadId });
  return takeTurn(threadId, runId, ask);
}

/** A model that runs several tools in order, then answers. Every call is real. */
function scriptedCalls(
  calls: { tool: string; args: Record<string, unknown> }[], answer: Record<string, unknown>,
): ToolModel {
  return async (input) => {
    for (const [i, call] of calls.entries()) {
      const tool = input.tools.find((t) => t.name === call.tool);
      assert.ok(tool, `${call.tool} was not bound`);
      await tool.run(call.args, { toolUse: { id: `t${i}`, name: call.tool, input: call.args } } as never);
    }
    return { ok: true, content: answer, model: 'claude-opus-5', inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
  };
}

// ---- R4: the write paths -----------------------------------------------------------------------

const ANSWERED = { answer: 'Written up.', citations: [], could_not_find: [] };

test('a draft proposed in a thread is pending, and remembers the conversation', async () => {
  const id = await startThread('Write up what Praj reported', ME);
  await turn(id, scriptedCalls([
    { tool: 'get_financials', args: { symbol: 'PRAJIND' } },
    { tool: 'draft_document', args: { kind: 'memo', title: 'Praj — December quarter', body: 'Revenue 219.1 cr.', symbol: 'PRAJIND' } },
  ], ANSWERED));

  const drafts = await pendingDrafts();
  assert.equal(drafts.length, 1);
  const d = drafts[0]!;
  assert.equal(d.agentKey, 'desk-analyst');
  assert.equal(d.threadId, id, 'the draft links back to the thread it was proposed in');
  assert.equal(d.symbol, 'PRAJIND');
  assert.equal(d.content['headline'], 'Praj — December quarter');
  assert.equal(d.content['kind'], 'memo');
  // Sources are the passages read, and nothing else. The thread reaches /review through
  // `thread_id` as a followable link; repeating it here printed the same id twice, once as
  // "Read the conversation →" and once as raw JSON under it.
  assert.deepEqual(d.sources, [], 'this turn read no passages, and says so');
  // field_order is captured at write time because jsonb re-sorts keys.
  assert.deepEqual(d.fieldOrder, ['headline', 'kind', 'body']);
});

test('accepting a chat draft lands a document of the kind it asked for', async () => {
  const id = await startThread('Write it up', ME);
  await turn(id, scriptedCalls([
    { tool: 'draft_document', args: { kind: 'memo', title: 'A memo', body: 'The body.' } },
  ], ANSWERED));

  const draft = (await pendingDrafts())[0]!;
  await acceptDraft(draft.id, null, ME);

  const doc = await readTxn(async (c) => {
    const { rows } = await c.query<{ title: string; kind: string; from_draft_id: string }>(
      'SELECT title, kind, from_draft_id FROM documents ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0]!;
  });
  assert.equal(doc.title, 'A memo');
  assert.equal(doc.kind, 'memo', 'the kind the draft chose, not the per-agent default');
  assert.equal(doc.from_draft_id, draft.id, 'the link the gate spends its design showing');
});

test('a kind outside the allowed two falls back rather than refusing at acceptance', async () => {
  // A draft is not worth refusing at the moment of acceptance over a field the reviewer can see.
  const id = await startThread('q', ME);
  await turn(id, scriptedCalls([
    { tool: 'draft_document', args: { kind: 'note', title: 'T', body: 'B' } },
  ], ANSWERED));
  const draft = (await pendingDrafts())[0]!;
  await acceptDraft(draft.id, { edits: { kind: 'sheet' } }, ME);

  const kind = await readTxn(async (c) => {
    const { rows } = await c.query<{ kind: string }>('SELECT kind FROM documents LIMIT 1');
    return rows[0]!.kind;
  });
  assert.equal(kind, 'note', 'sheet is not a kind a draft may choose; it fell back');
});

test('a draft with no body writes nothing', async () => {
  const id = await startThread('q', ME);
  await turn(id, scriptedCalls([
    { tool: 'draft_document', args: { kind: 'note', title: 'A title', body: '   ' } },
  ], ANSWERED));
  assert.deepEqual(await pendingDrafts(), []);
});

test('run_agent queues another agent, and says the answer goes to Review', async () => {
  const id = await startThread('Run the forensic checklist on Praj', ME);
  await turn(id, scriptedCalls([
    { tool: 'run_agent', args: { agent: 'forensics-review', symbol: 'PRAJIND' } },
  ], ANSWERED));

  const queued = await readTxn(async (c) => {
    const { rows } = await c.query<{ agent_key: string; company_id: string; status: string }>(
      "SELECT agent_key, company_id, status FROM agent_runs WHERE agent_key <> 'desk-analyst'",
    );
    return rows;
  });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.agent_key, 'forensics-review');
  assert.equal(queued[0]!.company_id, CO);

  const reply = (await threadWithMessages(id))!.messages[1]!;
  assert.match(reply.toolCalls[0]!.resultSummary, /review queue, not to this thread/);
});

test('run_agent refuses an agent a thread cannot supply a subject for', async () => {
  // results-figures needs a specific fundamentals row. Queueing it from a thread yields a run that
  // claims, fails, retries twice and lands on /agents as a failure nobody caused on purpose.
  const id = await startThread('q', ME);
  await turn(id, scriptedCalls([
    { tool: 'run_agent', args: { agent: 'results-figures', symbol: 'PRAJIND' } },
  ], ANSWERED));

  const others = await readTxn(async (c) => {
    const { rowCount } = await c.query("SELECT 1 FROM agent_runs WHERE agent_key <> 'desk-analyst'");
    return rowCount ?? 0;
  });
  assert.equal(others, 0, 'nothing was queued');
  const reply = (await threadWithMessages(id))!.messages[1]!;
  assert.match(reply.toolCalls[0]!.resultSummary, /cannot be queued from a thread/);
});

test('run_agent cannot queue the desk analyst — a loop with a bill', async () => {
  const id = await startThread('q', ME);
  await turn(id, scriptedCalls([
    { tool: 'run_agent', args: { agent: 'desk-analyst', symbol: 'PRAJIND' } },
  ], ANSWERED));
  const mine = await readTxn(async (c) => {
    const { rowCount } = await c.query("SELECT 1 FROM agent_runs WHERE agent_key = 'desk-analyst'");
    return rowCount ?? 0;
  });
  assert.equal(mine, 1, 'only this turn’s own run exists');
});

test('every agent run_agent offers is seeded, enabled and calls a model', async () => {
  // The list is a constant in queue-run.ts. Deleting or disabling one of these should break this
  // test rather than the tool, which would otherwise queue a run that can never be claimed.
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ key: string; model: string; enabled: boolean }>(
      "SELECT key, model, enabled FROM agents WHERE key = ANY($1)",
      [INVOCABLE_KEYS],
    );
    return rows;
  });
  assert.equal(rows.length, INVOCABLE_KEYS.length, 'every named agent exists');
  for (const r of rows) {
    assert.ok(r.enabled, `${r.key} is enabled`);
    assert.notEqual(r.model, 'none', `${r.key} calls a model`);
  }
});
