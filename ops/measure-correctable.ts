/**
 * How much of each agent's draft a reviewer can actually correct.
 *
 * `lib/agents/distil.ts` calls `MIN_OBSERVATIONS = 3` and `MIN_DISTANCE = 0.25` *"v2's measured
 * defaults, carried unchanged"* — and they were measured against flat drafts, where `/review`
 * offered a handful of textareas and one draft could produce at most one correction per field.
 * Once a correction can reach inside a draft that stops being true: a forensic review offers a
 * position per answer, a brief a position per bullet. Whether three drafts still mean the same
 * thing depends on how many chances each draft has to disagree, and that is this number.
 *
 * This tree's standard on carrying an unmeasured threshold forward is on the record — the relevance
 * floor was refused because *"shipping an unmeasured threshold is the mistake that finding exists
 * to prevent"* — so the figure goes in the plan file rather than staying an assumption.
 *
 *   DATABASE_URL=postgres:///trisula_v3_dev pnpm exec tsx ops/measure-correctable.ts
 *
 * Read-only, no model call. Counts positions; it does not run the distiller.
 */
import { closePool, readTxn } from '../lib/db.ts';
import { positions } from '../lib/agents/distance.ts';
import { shape } from '../lib/agents/paths.ts';
import { fieldAt, shapeFor, type Field } from '../lib/agents/shapes.ts';

interface Row {
  agent_key: string;
  content: Record<string, unknown>;
}

const kindOf = (f: Field | null): string => f?.kind ?? 'undeclared';

async function main(): Promise<void> {
  const { rows } = await readTxn((c) =>
    c.query<Row>(
      `SELECT DISTINCT ON (agent_key) agent_key, content
         FROM ai_drafts ORDER BY agent_key, created_at DESC`,
    ),
  );

  // Zero items is a failure, and this is a script whose output is pasted into a plan file to
  // settle MIN_OBSERVATIONS. An empty table prints a header row and exits 0, which reads as
  // "measured, and the answer was nothing" — the one thing it must not be allowed to mean.
  if (rows.length === 0) {
    throw new Error(
      'measure-correctable: `ai_drafts` is empty — no agent has produced a draft, so there are no\n' +
        '  positions to count. Run a sweep first:  pnpm exec tsx jobs/agents.ts\n' +
        '  If you expected drafts, DATABASE_URL is pointing at the wrong database.',
    );
  }

  console.log('agent              positions  correctable  shapes  read-only');
  for (const r of rows) {
    const declared = shapeFor(r.agent_key, r.content);
    // The same walk `draftDistance` uses, so this counts what that function divides by.
    const all = positions(r.content, r.content);
    const open = all.filter((p) => {
      const f = fieldAt(declared, p.path);
      if (f === null) return typeof p.from === 'string';
      return f.kind === 'text' || f.kind === 'choice' || (f.kind === 'list' && f.removable);
    });
    const shapes = new Set(open.map((p) => shape(p.path))).size;
    const fixed = all.length - open.length;

    console.log(
      `${r.agent_key.padEnd(18)} ${String(all.length).padStart(9)}  ${String(open.length).padStart(11)}` +
        `  ${String(shapes).padStart(6)}  ${String(fixed).padStart(9)}`,
    );

    // Which shapes, because "28 positions" says nothing about how many different mistakes they are.
    const byShape = new Map<string, number>();
    for (const p of open) byShape.set(shape(p.path), (byShape.get(shape(p.path)) ?? 0) + 1);
    for (const [s, n] of [...byShape].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${s.padEnd(40)} ${String(n).padStart(3)} × ${kindOf(fieldAt(declared, s.replace(/\[\]/g, '[0]')))}`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
