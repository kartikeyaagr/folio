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
import { bindTools, TOOLS, toolReads, toolWrites, UnknownTool } from './index.ts';
import { resolveSubject, type ToolContext } from './spec.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, rel), 'utf8');

/**
 * Table names a file's SQL touches, read or written.
 *
 * `INSERT INTO` and `UPDATE` are in the pattern because R4 added tools that write, and the version
 * without them reported `draft_document` as declaring a table no SQL touched — its only statement
 * is an `INSERT INTO ai_drafts`, which has no `FROM` at all. The test caught that on the first run,
 * which is the argument for having it.
 *
 * CTE aliases are excluded by name because `search.ts` fuses two of them; `LATERAL` because it
 * follows a JOIN without being a table. Deliberately crude — its job is to catch a declaration that
 * names a table nothing touches, not to parse SQL.
 */
function tablesIn(source: string): Set<string> {
  // Only string literals that begin with a SQL verb are scanned, and that narrowing is the whole
  // trick. Scanning the file as prose reads English as SQL: "from here", "update before" and
  // "proposed from inside a chat turn" all matched the pattern below and arrived as tables called
  // `here`, `before` and `inside` the moment this directory grew prose-heavy headers and
  // user-facing refusal messages. Comments and messages are not SQL; the statements are.
  const skip = new Set(['lateral', 'v', 'f', 'q', 'c', 'h', 'p', 's', 'a', 'co', 'r']);
  const found = new Set<string>();

  // Comments go first so that an apostrophe in prose — "the fund's", "TypeScript loses" — cannot
  // open a string the scanner then reads to the next apostrophe, swallowing real statements on the
  // way. All three quote forms are consumed as units for the same reason: a double-quoted message
  // containing an apostrophe desynchronises a scanner that only knows about single quotes.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

  for (const literal of code.matchAll(/`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const body = literal[1] ?? literal[2] ?? literal[3] ?? '';
    if (!/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) continue;
    // `--` inside the statement is a SQL comment, and several in this tree name tables in prose.
    const sql = body.replace(/--.*$/gm, ' ');
    for (const m of sql.matchAll(/\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
      const name = m[1]!.toLowerCase();
      if (!skip.has(name)) found.add(name);
    }
  }
  return found;
}

/**
 * Where each tool's SQL actually lives.
 *
 * `spec.ts` is in every row because `resolveSubject` is what reads `companies`, and every tool
 * calls it. Four of the six delegate their main query to a module that holds other queries too, so
 * those get containment rather than equality — stated here rather than left implied, because a
 * check that looks stronger than it is would be worse than this one.
 */
const SQL_LIVES_IN: Record<string, { files: string[]; exact: boolean }> = {
  search_corpus: { files: ['./spec.ts', '../../retrieval/search.ts'], exact: false },
  get_financials: { files: ['./spec.ts', './financials.ts'], exact: true },
  get_position: { files: ['./spec.ts', '../../book.ts'], exact: false },
  list_filings: { files: ['./spec.ts', '../../filings.ts'], exact: false },
  run_agent: { files: ['./spec.ts', '../queue.ts'], exact: false },
  draft_document: { files: ['./spec.ts', './draft.ts'], exact: true },
};

test('every tool is accounted for here', () => {
  assert.deepEqual([...TOOLS.keys()].sort(), Object.keys(SQL_LIVES_IN).sort());
});

for (const [name, where] of Object.entries(SQL_LIVES_IN)) {
  test(`${name} declares the tables its SQL names`, () => {
    const spec = TOOLS.get(name)!;
    const declared = [...spec.reads, ...(spec.writes ?? [])];
    const queried = new Set<string>();
    for (const file of where.files) for (const t of tablesIn(read(file))) queried.add(t);

    for (const table of declared) {
      assert.ok(
        queried.has(table),
        `${name} declares ${table} but no SQL in ${where.files.join(', ')} touches it`,
      );
    }
    if (where.exact) {
      // The tool owns its SQL, so the reverse holds too: nothing is read that was not declared.
      assert.deepEqual(
        [...queried].sort(), [...declared].sort(),
        `${name} touches exactly what it declares`,
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

// ---- what a tool may write ---------------------------------------------------------------------

test('the only tables any tool writes are the two that make up the review queue', () => {
  // The containment argument in spec.ts's header rests on exactly this. §9.2: "No tool has a side
  // effect outside the gate. run_agent enqueues; draft_document writes a pending draft. Neither
  // publishes." A third write tool has to change this line, which is the point — it forces the
  // argument to be made again rather than quietly weakened.
  assert.deepEqual(toolWrites([...TOOLS.keys()]), ['agent_runs', 'ai_drafts']);
});

test('the ledger is unreachable, and not because a transaction happens to be read-only', () => {
  // A review gate on ai_drafts would not protect a transactions row, because a trade is not a
  // draft. What protects it is that no tool names these tables at all.
  const ledger = ['transactions', 'cash_ledger', 'holdings', 'tax_lots'];
  const written = toolWrites([...TOOLS.keys()]);
  for (const table of ledger) {
    assert.ok(!written.includes(table), `no tool writes ${table}`);
  }
  // get_position reads the book on purpose — §6.2 drops v2's constraint excluding it, because
  // "what do we own in this and what did it cost" is a reason to open a chat.
  assert.ok(toolReads(['get_position']).includes('holdings'));
});

test('a writing tool declares what it writes', () => {
  // A tool whose SQL writes but whose spec says nothing would pass every check above by omission.
  for (const name of ['run_agent', 'draft_document']) {
    const spec = TOOLS.get(name)!;
    assert.ok((spec.writes ?? []).length > 0, `${name} declares its writes`);
  }
  for (const name of ['search_corpus', 'get_financials', 'get_position', 'list_filings']) {
    assert.deepEqual(TOOLS.get(name)!.writes ?? [], [], `${name} writes nothing`);
  }
});
