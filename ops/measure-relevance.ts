/**
 * Task 10: measure the relevance floor (docs/specs/v4.md §14).
 *
 * Scores each of the twenty questions in `tasks/relevance-questions.md` against the *underlying*
 * cosine similarity and ts_rank — not `search()`'s fused RRF score, which is derived from rank and
 * cannot separate relevant from irrelevant (see the file header of `lib/retrieval/search.ts` and
 * `tasks/relevance-2026-09-10.md` for the measurement that established this). This script queries
 * the two ranking expressions directly, unfused, the same way `search.ts`'s two CTEs do, so the
 * numbers it prints are exactly what a floor on cosine similarity would be gating.
 *
 * Read-only. Runs no `writeTxn`/`serviceTxn`, only `readTxn` — it must never be able to change the
 * corpus it is measuring.
 *
 * Re-run when the desk corrects `tasks/relevance-questions.md`:
 *
 *   1. Update the QUESTIONS array below to match the corrected file. Deliberately not parsed from
 *      that file — its prose (an anchor sentence per question) is for people, not a parser, and a
 *      parser brittle enough to break on prose edits would fail exactly when the desk is fixing
 *      something.
 *   2. DATABASE_URL=postgres:///trisula_v3_dev EMBED_MODEL_DIR=.models/bge-small-en-v1.5 \
 *        pnpm exec tsx ops/measure-relevance.ts
 *
 * The printed snippet is what "genuinely relevant" is judged against — read it, don't just read
 * the score.
 */
import { closePool, readTxn, type Client } from '../lib/db.ts';
import { embed, toVector, EMBED_MODEL } from '../lib/retrieval/embed.ts';

interface Question {
  id: string;
  part: 'A' | 'B';
  text: string;
}

// Verbatim from tasks/relevance-questions.md, 10-Sep-2026 draft. Keep this list and that file in
// sync by hand — see the re-run note above for why.
const QUESTIONS: Question[] = [
  { id: 'A1', part: 'A', text: 'What has management said about the auditor?' },
  { id: 'A2', part: 'A', text: 'Has Praj declined to give margin guidance, and when?' },
  { id: 'A3', part: 'A', text: 'What does Praj disclose about contingent liabilities?' },
  { id: 'A4', part: 'A', text: 'What did Praj say on its most recent analyst call about order book or capacity?' },
  { id: 'A5', part: 'A', text: 'Which ESOP allotments has Praj made, and when?' },
  { id: 'A6', part: 'A', text: 'What was in the FY2025 AGM notice?' },
  { id: 'A7', part: 'A', text: 'What has Thaai Casting filed since we started following it?' },
  { id: 'A8', part: 'A', text: 'What does Aeron Composite make?' },
  { id: 'A9', part: 'A', text: 'Has Praj announced any related-party transaction?' },
  { id: 'A10', part: 'A', text: 'What did the last board meeting decide?' },
  { id: 'B1', part: 'B', text: "What is management's reputation among ex-employees?" },
  { id: 'B2', part: 'B', text: "What is Praj's management attrition rate?" },
  { id: 'B3', part: 'B', text: 'Has management delivered what it promised three years ago?' },
  { id: 'B4', part: 'B', text: 'What is our XIRR on this position?' },
  { id: 'B5', part: 'B', text: 'What did the custodian statement say this month?' },
  { id: 'B6', part: 'B', text: "What is in Aeron's DRHP?" },
  { id: 'B7', part: 'B', text: 'What does the sell-side think Praj is worth?' },
  { id: 'B8', part: 'B', text: "What did Praj's FY2019 annual report say about capex?" },
  { id: 'B9', part: 'B', text: "How does Praj's margin compare to Thermax's?" },
  { id: 'B10', part: 'B', text: "What will Praj's order book be next quarter?" },
];

interface CosineRow {
  title: string;
  kind: string;
  text: string;
  cosine: number;
}

interface FtsRow {
  title: string;
  rank: number;
}

/**
 * The top-N cosine hits, unfiltered and unfused — the whole 12,136-chunk corpus, exactly the
 * candidate pool `search()`'s vector CTE draws its top 30 from before RRF ever runs. N=5, not 1:
 * a single top hit is what the floor gates on, but 5 is what a person needs to judge relevance
 * honestly — the top hit for a filing-heavy corpus is often a same-template announcement blurb
 * ("Dividend: Praj Industries Limited has informed the Exchange…"), and whether the genuinely
 * relevant passage is one slot down or entirely absent is a different finding than the floor
 * number itself.
 */
async function topCosine(c: Client, query: string, n: number): Promise<CosineRow[]> {
  const [vector] = await embed([query]);
  const { rows } = await c.query<CosineRow>(
    `SELECT s.title, s.kind, c.text, (1 - (c.embedding <=> $1::vector))::float8 AS cosine
       FROM chunks c JOIN sources s ON s.id = c.source_id
      WHERE c.embedding IS NOT NULL AND c.embed_model = $2
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    [toVector(vector!), EMBED_MODEL, n],
  );
  return rows;
}

/** Same OR-ed websearch_to_tsquery as search.ts's `q` CTE — recorded for the record, not the gate. */
async function bestTsRank(c: Client, query: string): Promise<FtsRow | null> {
  const { rows } = await c.query<FtsRow>(
    `WITH q AS (
       SELECT CASE WHEN websearch_to_tsquery('english', $1)::text = '' THEN NULL
                   ELSE replace(websearch_to_tsquery('english', $1)::text, ' & ', ' | ')::tsquery
              END AS query
     )
     SELECT s.title, ts_rank(c.fts, q.query)::float8 AS rank
       FROM chunks c JOIN sources s ON s.id = c.source_id CROSS JOIN q
      WHERE q.query IS NOT NULL AND c.fts @@ q.query
      ORDER BY ts_rank(c.fts, q.query) DESC
      LIMIT 1`,
    [query],
  );
  return rows[0] ?? null;
}

const TOP_N = 5;

/**
 * Why this script refuses an empty corpus rather than printing twenty `n/a` lines: the twenty
 * numbers below are what a floor on cosine similarity gets argued from, and a run against nothing
 * produces a page that looks like a measurement and is not. Zero items is a failure here for the
 * same reason it is in every job — and this one is worse than a job, because a job's silence is
 * read by a machine and this output is read by a person about to decide something.
 *
 * Both counts are taken because they name different causes: nothing indexed at all, against a
 * corpus indexed under some other model.
 */
async function corpusSize(c: Client): Promise<{ total: number; embedded: number }> {
  const { rows } = await c.query<{ total: number; embedded: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL AND embed_model = $1)::int AS embedded
       FROM chunks`,
    [EMBED_MODEL],
  );
  return rows[0]!;
}

function noCorpusDiagnostic(total: number): string {
  if (total === 0) {
    return (
      'measure-relevance: `chunks` is empty — there is no corpus to measure against.\n' +
      '  Index one first:  pnpm exec tsx jobs/index-content.ts --all\n' +
      '  If you expected a corpus, DATABASE_URL is pointing at the wrong database.'
    );
  }
  return (
    `measure-relevance: ${total} chunks, and not one of them carries an embedding for ` +
    `${EMBED_MODEL}.\n` +
    '  Either the indexer has not reached them:  pnpm exec tsx jobs/index-content.ts --all\n' +
    `  or they were embedded under a different model, in which case EMBED_MODEL moved and every ` +
    'vector needs rebuilding — a migration, not a re-run of this script.'
  );
}

async function main(): Promise<void> {
  // One transaction, so the guard and the twenty measurements see the same snapshot: a corpus
  // that was there when it was counted cannot be gone by the time it is queried.
  const refusal = await readTxn(async (c) => {
    const { total, embedded } = await corpusSize(c);
    if (embedded === 0) return noCorpusDiagnostic(total);

    for (const q of QUESTIONS) {
      const [cosRows, fts] = await Promise.all([topCosine(c, q.text, TOP_N), bestTsRank(c, q.text)]);
      const top = cosRows[0];
      console.log(`\n${q.id} [Part ${q.part}] ${q.text}`);
      // `n/a`, not `0.00000`. No full-text hit at all and a hit that scored zero are different
      // findings, and printing the second for the first is the mistake `<Blank why=…>` exists to
      // prevent everywhere else in this system: a zero reads as a measured fact.
      console.log(
        `  best cosine=${top ? top.cosine.toFixed(4) : 'n/a'}` +
          `  best ts_rank=${fts ? fts.rank.toFixed(5) : 'n/a'}`,
      );
      if (fts) console.log(`  top hit (ts_rank): ${fts.title}`);
      // Unreachable while the guard above holds, since both read the same snapshot. Kept as the
      // line that would say so if that ever stopped being true.
      if (cosRows.length === 0) {
        console.log('  top hit (cosine): none — no embedded chunk in the corpus at all');
        continue;
      }
      cosRows.forEach((r, i) => {
        console.log(`  #${i + 1} cosine=${r.cosine.toFixed(4)} [${r.kind}] ${r.title}`);
        console.log(`     ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      });
    }
    return null;
  });

  await closePool();
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
