/**
 * A turn, end to end: the thread, the tools the model actually ran, and what was written down.
 *
 * The scripted model here does something the one-shot suite's cannot — it *calls the tools it was
 * handed*. That is the only way to exercise the path that matters: a real query, through `served()`,
 * into `chat_tool_calls`. A fake that only returns an answer would leave the transparency surface
 * untested, and §4.2 calls it not optional.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { enqueue } from '../agents/queue.ts';
import type { ToolModel } from '../agents/loop.ts';
import { ask, listThreads, MAX_HISTORY_CHARS, recordAnswer, startThread, threadWithMessages, titleFrom, withinBudget, type MessageRow } from './threads.ts';
import { render, takeTurn } from './turn.ts';

const DB = `trisula_chat_${process.pid}`;
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
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    // Documents before drafts before runs: a document records the draft it came from and a draft
    // records its run, and each foreign key refuses to let the other go while it holds it.
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM chat_tool_calls');
    await c.query('DELETE FROM chat_messages');
    await c.query('DELETE FROM chat_threads');
    await c.query('DELETE FROM agent_runs');
  });
});

/**
 * A turn, the way production takes one: a queued run, then `takeTurn` against it.
 *
 * The run is real rather than a made-up id because `ai_drafts.run_id` is NOT NULL and references
 * `agent_runs` — a draft proposed mid-turn hangs on it, so a fake id would pass every test that
 * does not write a draft and fail the one that does.
 */
async function turn(threadId: string, ask: ToolModel) {
  const runId = await enqueue({ agentKey: 'desk-analyst', subjectRef: threadId });
  return takeTurn(threadId, runId, ask);
}

/** A model that runs one named tool, then answers. The tool call is real; only the model is not. */
function scriptedTurn(
  toolName: string, args: Record<string, unknown>, answer: Record<string, unknown>,
): ToolModel {
  return async (input) => {
    const tool = input.tools.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} was not bound`);
    await tool.run(args, { toolUse: { id: 't1', name: toolName, input: args } } as never);
    return { ok: true, content: answer, model: 'claude-opus-5', inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
  };
}

// ---- threads -----------------------------------------------------------------------------------

test('a thread is named from its first message, on one line', () => {
  assert.equal(titleFrom('  What did   Praj say\n about margins? '), 'What did Praj say about margins?');
  assert.equal(titleFrom('x'.repeat(200)).length, 80);
});

test('a thread and its first message arrive together', async () => {
  const id = await startThread('What did Praj say about margins?', ME);
  const found = await threadWithMessages(id);
  assert.ok(found);
  assert.equal(found.thread.title, 'What did Praj say about margins?');
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0]!.role, 'person');
  assert.equal(found.messages[0]!.seq, 1);
});

test('an empty question is refused rather than opening a nameless thread', async () => {
  await assert.rejects(() => startThread('   ', ME), /starts with a question/);
  assert.deepEqual(await listThreads(), []);
});

test('the history budget drops the oldest first and always keeps one', () => {
  const msg = (seq: number, body: string): MessageRow => ({
    id: `m${seq}`, seq, role: seq % 2 ? 'person' : 'agent', body,
    writtenAt: new Date(), writtenBy: ME,
    inputTokens: null, outputTokens: null, costUsd: null, toolCalls: [],
  });
  // Twenty-four messages is twelve turns; §6.1's cap is ten.
  const many = Array.from({ length: 24 }, (_, i) => msg(i + 1, 'short'));
  assert.equal(withinBudget(many).length, 20);
  assert.equal(withinBudget(many)[0]!.seq, 5, 'the oldest went first');

  // One oversized message is still sent: a thread whose only question is long must not be
  // silently reduced to nothing, which would make the model answer a question it never saw.
  const huge = [msg(1, 'x'.repeat(MAX_HISTORY_CHARS * 2))];
  assert.equal(withinBudget(huge).length, 1);
});

// ---- a turn ------------------------------------------------------------------------------------

test('a turn writes the answer and what it read, and the figures are real', async () => {
  const id = await startThread('What did Praj report last quarter?', ME);
  const result = await turn(id, scriptedTurn('get_financials', { symbol: 'PRAJIND' }, {
    answer: 'Revenue was 219.1 cr [chunk 1].',
    citations: [{ chunk_id: '1', supports: 'revenue for the December quarter' }],
    could_not_find: [],
  }));

  assert.equal(result.calls, 1);
  const found = await threadWithMessages(id);
  assert.equal(found!.messages.length, 2);
  const reply = found!.messages[1]!;
  assert.equal(reply.role, 'agent');
  assert.equal(reply.writtenBy, 'system:agents');
  assert.match(reply.body, /219\.1 cr/);
  assert.match(reply.body, /Built from/);

  const call = reply.toolCalls[0]!;
  assert.equal(call.tool, 'get_financials');
  assert.equal(call.error, null);
  // The summary is the tool's real output, so a wrong figure is visible here without re-running it.
  assert.match(call.resultSummary, /219\.1 cr/);
});

test('a tool that refuses records the refusal, and the turn still answers', async () => {
  const id = await startThread('What does ENRON hold?', ME);
  await turn(id, scriptedTurn('get_financials', { symbol: 'ENRON' }, {
    answer: 'This system does not follow that name.',
    citations: [],
    could_not_find: ['any company with symbol ENRON'],
  }));

  const found = await threadWithMessages(id);
  const reply = found!.messages[1]!;
  assert.match(reply.body, /Could not find/);
  // A refusal is an ordinary result, not an error: the tool answered, it just said no.
  assert.equal(reply.toolCalls[0]!.error, null);
  assert.match(reply.toolCalls[0]!.resultSummary, /ENRON/);
});

test('a model failure still leaves a message saying which failure it was', async () => {
  // A turn that left nothing would be indistinguishable from a question nobody had asked yet.
  const id = await startThread('Anything on Praj?', ME);
  await turn(id, async () => ({ ok: false, kind: 'refusal', detail: 'declined (cyber)' }));

  const found = await threadWithMessages(id);
  assert.equal(found!.messages.length, 2);
  assert.match(found!.messages[1]!.body, /refusal.*cyber/);
});

// ---- what a turn cost --------------------------------------------------------------------------

test('a turn records what it spent', async () => {
  // Found by running it: the first live turn made six tool calls and the system could not say what
  // it had spent, because `takeTurn` computed the figure and dropped it.
  const id = await startThread('What did Praj report?', ME);
  await turn(id, scriptedTurn('get_financials', { symbol: 'PRAJIND' }, {
    answer: 'Revenue was 219.1 cr.', citations: [], could_not_find: [],
  }));

  const reply = (await threadWithMessages(id))!.messages[1]!;
  assert.equal(reply.inputTokens, 10);
  assert.equal(reply.outputTokens, 5);
  assert.equal(reply.costUsd, 0.001);
});

test('a turn that failed records null, never zero', async () => {
  // D5: a zero is a claim about the bill, a null is an admission. A failed turn really did spend
  // tokens — recording 0 would say it was free, which is the lie v2's $0.00 dashboard told.
  const id = await startThread('Anything?', ME);
  await turn(id, async () => ({ ok: false, kind: 'error', detail: 'the far end hung up' }));

  const reply = (await threadWithMessages(id))!.messages[1]!;
  assert.equal(reply.costUsd, null);
  assert.equal(reply.inputTokens, null);
});

test('a person’s message cannot carry a price', async () => {
  // Enforced by the schema, not by convention: a priced person-message would mean the figure came
  // from somewhere other than a model call, and no reader could tell where.
  const id = await startThread('q', ME);
  await assert.rejects(
    () => serviceTxn('system:agents', async (c) => {
      await c.query(
        `INSERT INTO chat_messages (id, thread_id, seq, role, body, written_by, cost_usd)
         VALUES ('x',$1,9,'person','typed by a person','system:agents',0.5)`,
        [id],
      );
    }),
    /chat_messages_only_agents_cost/,
  );
});

test('a second question continues the same thread in order', async () => {
  const id = await startThread('First question', ME);
  await ask(id, 'Second question', ME);
  const found = await threadWithMessages(id);
  assert.deepEqual(found!.messages.map((m) => m.seq), [1, 2]);
  assert.deepEqual(found!.messages.map((m) => m.body), ['First question', 'Second question']);
});

test('the message and its tool calls land together or not at all', async () => {
  // Written in one transaction: an answer whose provenance failed to land is worse than no answer,
  // because it still reads like something that was checked.
  const id = await startThread('q', ME);
  await recordAnswer(id, 'an answer', [
    { tool: 'get_financials', arguments: { symbol: 'PRAJIND' }, resultSummary: 's', chunkIds: [], durationMs: 3, error: null },
    { tool: 'search_corpus', arguments: { query: 'x' }, resultSummary: 't', chunkIds: ['7', '9'], durationMs: 4, error: null },
  ], { inputTokens: 120, outputTokens: 40, costUsd: 0.0016 });
  const found = await threadWithMessages(id);
  const calls = found!.messages[1]!.toolCalls;
  assert.deepEqual(calls.map((c) => c.tool), ['get_financials', 'search_corpus'], 'in the order they ran');
  assert.deepEqual(calls[1]!.chunkIds, ['7', '9']);
});

test('an agent message is never attributed to a person', async () => {
  const id = await startThread('q', ME);
  await recordAnswer(id, 'an answer', [], { inputTokens: null, outputTokens: null, costUsd: null });
  const who = await readTxn(async (c) => {
    const { rows } = await c.query<{ written_by: string; role: string }>(
      "SELECT written_by, role FROM chat_messages WHERE role = 'agent'",
    );
    return rows[0]!;
  });
  assert.equal(who.written_by, 'system:agents');
});

// ---- rendering ---------------------------------------------------------------------------------

test('an answer with nothing missing does not claim a "Could not find" section', () => {
  const body = render({ answer: 'Plain answer.', citations: [], could_not_find: [] });
  assert.equal(body, 'Plain answer.');
});

test('what it could not find is rendered when there is any', () => {
  const body = render({
    answer: 'Partly.', citations: [{ chunk_id: '4', supports: 'the revenue line' }],
    could_not_find: ['the segment split'],
  });
  assert.match(body, /Built from\n- \[chunk 4\] the revenue line/);
  assert.match(body, /Could not find\n- the segment split/);
});
