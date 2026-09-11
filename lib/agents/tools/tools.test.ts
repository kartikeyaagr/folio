/**
 * That a tool's declared `reads` is true, and that the scope check bites.
 *
 * The point of this file: before R3, `assertInScope` compared a handler's hardcoded `READS` array
 * against `agents.data_scope` — a declaration against a declaration, neither of which had ever seen
 * a query. Both could be wrong together and nothing would say so. Here the declaration is checked
 * against the SQL itself.
 *
 * No database and no network: `ToolContext.reads` is a type rather than `typeof readTxn` precisely
 * so a test can hand it canned rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ScopeViolation, type AgentRow } from '../runner.ts';
import { bindTools, TOOLS, toolReads, UnknownTool } from './index.ts';
import { resolveSubject, type ToolContext } from './spec.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, rel), 'utf8');

/**
 * Table names a file's SQL reads.
 *
 * CTE aliases are excluded by name because `search.ts` fuses two of them; `LATERAL` because it
 * follows a JOIN without being a table. Deliberately crude — its job is to catch a `reads` entry
 * that names a table nothing queries, not to parse SQL.
 */
function tablesIn(source: string): Set<string> {
  const skip = new Set(['lateral', 'v', 'f', 'q', 'c', 'h', 'p', 's', 'a', 'co', 'r']);
  const found = new Set<string>();
  for (const m of source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = m[1]!.toLowerCase();
    if (!skip.has(name)) found.add(name);
  }
  return found;
}

/**
 * Where each tool's SQL actually lives.
 *
 * `spec.ts` is in every row because `resolveSubject` is what reads `companies`, and every tool
 * calls it. Three of the four delegate their main query to a module that holds other queries too,
 * so those get containment rather than equality — stated here rather than left implied, because a
 * check that looks stronger than it is would be worse than this one.
 */
const SQL_LIVES_IN: Record<string, { files: string[]; exact: boolean }> = {
  search_corpus: { files: ['./spec.ts', '../../retrieval/search.ts'], exact: false },
  get_financials: { files: ['./spec.ts', './financials.ts'], exact: true },
  get_position: { files: ['./spec.ts', '../../book.ts'], exact: false },
  list_filings: { files: ['./spec.ts', '../../filings.ts'], exact: false },
};

test('every tool is accounted for here', () => {
  assert.deepEqual([...TOOLS.keys()].sort(), Object.keys(SQL_LIVES_IN).sort());
});

for (const [name, where] of Object.entries(SQL_LIVES_IN)) {
  test(`${name} declares the tables its SQL names`, () => {
    const spec = TOOLS.get(name)!;
    const queried = new Set<string>();
    for (const file of where.files) for (const t of tablesIn(read(file))) queried.add(t);

    for (const declared of spec.reads) {
      assert.ok(
        queried.has(declared),
        `${name} declares ${declared} but no SQL in ${where.files.join(', ')} reads it`,
      );
    }
    if (where.exact) {
      // The tool owns its SQL, so the reverse holds too: nothing is read that was not declared.
      assert.deepEqual(
        [...queried].sort(), [...spec.reads].sort(),
        `${name} reads exactly what it declares`,
      );
    }
  });
}

// ---- the scope check ---------------------------------------------------------------------------

const agent = (scope: string[]): AgentRow => ({
  key: 'desk-analyst', label: 'test', purpose: 'test', model: 'claude-opus-5',
  effort: 'xhigh', data_scope: scope, tools: [...TOOLS.keys()], notify_on_draft: false,
});

const ctx: ToolContext = { reads: async (fn) => fn({} as never), companyId: null };

test('an agent whose row does not name the table cannot be handed the tool', () => {
  // The failure that matters: agent 8 seeded without `chunks` in its scope. Nothing else in the
  // system would notice — the model would simply answer from less than it was meant to use.
  assert.throws(
    () => bindTools(agent(['companies']), ['search_corpus'], ctx),
    (e: Error) => e instanceof ScopeViolation && /chunks/.test(e.message),
  );
});

test('a sufficient scope binds every tool', () => {
  const scope = toolReads([...TOOLS.keys()]);
  const bound = bindTools(agent(scope), [...TOOLS.keys()], ctx);
  assert.equal(bound.length, TOOLS.size);
  assert.deepEqual(bound.map((t) => t.name).sort(), [...TOOLS.keys()].sort());
});

test('an unknown tool raises rather than yielding a smaller toolset', () => {
  // Silently dropping it would leave an agent that cannot do what its row says it can, answering
  // anyway. The message names what does exist, because the next person to see it wrote a typo.
  assert.throws(
    () => bindTools(agent(['chunks']), ['search_the_web'], ctx),
    (e: Error) => e instanceof UnknownTool && /search_corpus/.test(e.message),
  );
});

// No test here for "scope is checked before any tool is built". The ordering is one line in
// `bindTools` and there is no seam to inject a counting spec through; a test written against the
// real registry would pass whatever the order was, which is lesson L3 — a test that had been
// passing by luck. If a seam appears, this is worth covering.

// ---- subject binding ---------------------------------------------------------------------------

/** A `reads` that answers `companies` lookups from a fixture instead of a database. */
function withCompanies(rows: { id: string; symbol: string; name: string }[]): ToolContext['reads'] {
  return async (fn) =>
    fn({
      query: async (_sql: string, params: unknown[]) => {
        const key = String(params[0]);
        const hit = rows.find((r) => r.id === key || r.symbol.toUpperCase() === key.toUpperCase());
        return { rows: hit ? [hit] : [] };
      },
    } as never);
}

const PRAJ = { id: 'co_1', symbol: 'PRAJIND', name: 'Praj Industries' };

test('a symbol the fund does not follow does not resolve', () => {
  // This is the containment. A crafted filing can name any symbol it likes; one that is not in
  // `companies` does not exist to be read, and no tool has another way to name a company.
  return resolveSubject({ reads: withCompanies([PRAJ]), companyId: null }, 'ENRON').then((r) => {
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /ENRON/.test(r.why));
  });
});

test('a pinned run refuses a different company rather than quietly reading its own', async () => {
  // Silently reading PRAJIND when asked for AERON would make a wrong answer look like a right one.
  const r = await resolveSubject({ reads: withCompanies([PRAJ]), companyId: 'co_1' }, 'AERON');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /PRAJIND/.test(r.why) && /AERON/.test(r.why));
});

test('a pinned run resolves its own company without being told which', async () => {
  const r = await resolveSubject({ reads: withCompanies([PRAJ]), companyId: 'co_1' });
  assert.ok(r.ok);
  assert.equal(r.company.symbol, 'PRAJIND');
});

test('an unpinned call with no symbol asks for one instead of guessing', async () => {
  const r = await resolveSubject({ reads: withCompanies([PRAJ]), companyId: null });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /symbol/.test(r.why));
});
