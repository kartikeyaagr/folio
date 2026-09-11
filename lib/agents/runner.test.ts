/**
 * The agent substrate.
 *
 * Every model call here goes through `scriptedModel`, so these tests spend no money, need no key,
 * and are deterministic. What they assert is the thing that actually matters: that a model which
 * misbehaves in each of four distinct ways produces a named, readable state and **never a draft**.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { costUsd, scriptedModel, scriptedOk, type Answer } from './model.ts';
import { assertInScope, drain, HANDLERS, registerHandler, ScopeViolation, type AgentRow } from './runner.ts';
import { enqueue, failedRuns, MAX_ATTEMPTS, requeue } from './queue.ts';
import { acceptDraft, diffFields, pendingDrafts, ReasonRequired, rejectDraft } from './review.ts';

const DB = `trisula_agents_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

const agentRow = (scope: string[]): AgentRow => ({
  key: 'test', label: 'Test', purpose: 'p', model: 'claude-opus-5',
  effort: 'high', data_scope: scope, tools: [], learning: false, notify_on_draft: false,
});

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega')", [CO]);
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
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
  });
});

// ---- scope --------------------------------------------------------------------------------------

test('an agent may not read outside its declared scope', () => {
  assert.doesNotThrow(() => assertInScope(agentRow(['filings']), ['filings']));
  assert.throws(() => assertInScope(agentRow(['filings']), ['filings', 'transactions']), ScopeViolation);
});

// ---- cost ---------------------------------------------------------------------------------------

test('cost is computed, and an unknown model yields null rather than zero', () => {
  assert.equal(costUsd('claude-opus-5', 1_000_000, 100_000), 5 + 2.5);
  assert.equal(costUsd('something-else', 1000, 1000), null, 'null is an admission; zero is a claim');
});

// ---- the four failure states --------------------------------------------------------------------

const failures: [string, Answer][] = [
  ['refusal', { ok: false, kind: 'refusal', detail: 'declined (cyber)' }],
  ['truncated', { ok: false, kind: 'truncated', detail: 'ran out of output room twice' }],
  ['unparseable', { ok: false, kind: 'unparseable', detail: 'response was not JSON' }],
  ['schema_mismatch', { ok: false, kind: 'schema_mismatch', detail: 'missing required: figures' }],
];

for (const [kind, answer] of failures) {
  test(`a ${kind} is recorded by name and writes no draft`, async () => {
    registerHandler('test', async (ctx) => {
      const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
      if (!a.ok) {
        const { raise } = await import('./runner.ts');
        raise(a);
      }
      return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
    });
    await serviceTxn('system:agents', async (c) => {
      await c.query(
        `INSERT INTO agents (key,label,purpose,trigger,model,data_scope)
         VALUES ('test','T','p','event','claude-opus-5','{}') ON CONFLICT (key) DO NOTHING`,
      );
    });
    await enqueue({ agentKey: 'test', companyId: CO });
    const r = await drain(1, scriptedModel([answer]));

    assert.equal(r.failed, 1);
    assert.equal(r.drafted, 0, 'no draft may be written for a failure');
    const run = await readTxn(async (c) => {
      const { rows } = await c.query<{ failure_kind: string; status: string }>(
        'SELECT failure_kind, status FROM agent_runs ORDER BY created_at DESC LIMIT 1',
      );
      return rows[0]!;
    });
    assert.equal(run.failure_kind, kind);
    assert.equal(run.status, 'queued', 'first attempt backs off rather than giving up');
    const drafts = await readTxn(async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM ai_drafts')).rows[0]!.n),
    );
    assert.equal(drafts, 0);
  });
}

test('a run gives up after MAX_ATTEMPTS and becomes visible as failed', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) {
      const { raise } = await import('./runner.ts');
      raise(a);
    }
    return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
  });
  const runId = await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([{ ok: false, kind: 'error', detail: 'boom' }]);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await serviceTxn('system:agents', async (c) => {
      await c.query("UPDATE agent_runs SET next_attempt_at = now() WHERE id = $1", [runId]);
    });
    await drain(1, model);
  }

  const failed = await failedRuns();
  assert.equal(failed.length, 1, 'a failed run must be findable; the sweep never re-offers it');
  assert.equal(failed[0]?.id, runId);

  assert.equal(await requeue(runId), true, 'and a person can put it back after looking');
  assert.equal((await failedRuns()).length, 0);
});

// ---- the happy path -----------------------------------------------------------------------------

test('a successful run writes one draft carrying cost and provenance', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: ctx.agent.model, system: 'sys', task: 'task', schema: {} });
    if (!a.ok) throw new Error('unexpected');
    return {
      draft: {
        content: a.content, situation: 'a test run with one prior period',
        sources: [{ kind: 'fundamentals', ref: 'f1' }],
        verification: { agreed: true }, model: a.model,
        inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd,
      },
    };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([scriptedOk({ headline: 'Revenue up 12%' })]);
  const r = await drain(1, model);

  assert.equal(r.drafted, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]?.task, 'task', 'the assembled prompt is assertable');

  const [d] = await pendingDrafts();
  assert.equal(d?.content['headline'], 'Revenue up 12%');
  assert.deepEqual(d?.sources, [{ kind: 'fundamentals', ref: 'f1' }]);
  assert.ok(Number(d?.costUsd) > 0, 'cost is a real number, not 0.00');
});

// ---- the review gate ----------------------------------------------------------------------------

test('accepting records what the person changed, field by field', async () => {
  assert.deepEqual(
    diffFields({ a: 1, b: 'x' }, { a: 1, b: 'y' }),
    { b: { from: 'x', to: 'y' } },
  );
});

test('accepting lands a document and closes the draft', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return {
      draft: {
        content: a.content, situation: 'a test run', sources: [],
        model: a.model, costUsd: a.costUsd,
      },
    };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'As filed' })]));

  const [d] = await pendingDrafts();
  await acceptDraft(d!.id, { edits: { headline: 'Corrected headline' } }, ME);

  const doc = await readTxn(async (c) => {
    const { rows } = await c.query<{ title: string; created_by: string }>(
      'SELECT title, created_by FROM documents',
    );
    return rows[0];
  });
  assert.equal(doc?.title, 'Corrected headline');
  assert.equal(doc?.created_by, ME, 'what lands in the record is the analyst\'s');

  const draft = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; edits: Record<string, unknown> }>(
      'SELECT status, edits FROM ai_drafts',
    );
    return rows[0]!;
  });
  assert.equal(draft.status, 'accepted');
  assert.deepEqual(draft.edits, { headline: { from: 'As filed', to: 'Corrected headline' } });
  assert.equal((await pendingDrafts()).length, 0);
});

test('rejecting requires a reason', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return { draft: { content: a.content, situation: 'a test run', sources: [], model: a.model } };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'h' })]));
  const [d] = await pendingDrafts();

  await assert.rejects(() => rejectDraft(d!.id, '   ', ME), ReasonRequired);
  await rejectDraft(d!.id, 'figures do not match the filing', ME);
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; reject_reason: string }>(
      'SELECT status, reject_reason FROM ai_drafts',
    );
    return rows[0]!;
  });
  assert.equal(row.status, 'rejected');
  assert.equal(row.reject_reason, 'figures do not match the filing');
});

test('a draft cannot be decided twice', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return { draft: { content: a.content, situation: 'a test run', sources: [], model: a.model } };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'h' })]));
  const [d] = await pendingDrafts();
  await acceptDraft(d!.id, null, ME);
  await assert.rejects(() => acceptDraft(d!.id, null, ME), /already accepted/);
});

test('the handler map is the only registry', () => {
  assert.ok(HANDLERS.has('test'));
});
