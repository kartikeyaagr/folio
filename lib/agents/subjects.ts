/**
 * What a person may pick when they ask an agent for work.
 *
 * **Read from the same tables the event sweeps read, filtered the same way.** That is the whole
 * correctness argument: a picker that offered a quarter to agent 7, or a superseded period to
 * agent 1, would enqueue a run that claims, throws, retries twice and lands under "Failed runs" as
 * something nobody meant to ask for. Each list below names the sweep it mirrors so the two can be
 * checked against each other by reading, and `subjects.test.ts` checks it by running.
 *
 * Deliberately **not** deduplicated against runs that already exist. The sweeps use
 * `NOT EXISTS (agent_key, subject_ref)` because they must never spend money twice unasked; a person
 * asking for a second reading of the same transcript has asked on purpose, and hiding the option
 * would leave them with no way to say "do that again" short of the `/agents` retry button they can
 * no longer see. What it is `already read` is said instead, so the choice is informed.
 */

import { readTxn } from '../db.ts';
import { INVOCABLE, type SubjectKind } from './invocable.ts';

export interface Subject {
  /** Goes on the run as `subject_ref`. */
  ref: string;
  label: string;
  /** Whether an agent run already exists for this subject. Said, never hidden. */
  alreadyRead: boolean;
}

/**
 * The filed periods agent 1 can read, newest first.
 *
 * Mirrors `results.pending()`: current rows only (`superseded_by IS NULL`). It does **not** mirror
 * that sweep's exclusion of periods already run — see this file's header.
 */
async function periods(companyId: string): Promise<Subject[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Subject>(
      `SELECT f.id AS ref,
              f.period_kind || ' to ' || f.period_end::text ||
                ' (' || f.basis || ')' AS label,
              EXISTS (SELECT 1 FROM agent_runs r
                       WHERE r.agent_key = 'results-figures' AND r.subject_ref = f.id) AS "alreadyRead"
         FROM fundamentals f
        WHERE f.company_id = $1 AND f.superseded_by IS NULL
        ORDER BY f.period_end DESC, f.id
        LIMIT 40`,
      [companyId],
    );
    return rows;
  });
}

/**
 * The transcripts agent 2 can read, newest first.
 *
 * Mirrors `concall.pending()`: `documents.kind = 'transcript'`, not archived. The length floor the
 * handler enforces (`MIN_TRANSCRIPT_CHARS`) is applied here too — a stub or a paste that went wrong
 * is refused by the handler after the run has been claimed, and offering it would be offering a
 * failure.
 */
async function transcripts(companyId: string): Promise<Subject[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Subject>(
      `SELECT d.id AS ref,
              d.created_at::date::text || ' — ' || d.title AS label,
              EXISTS (SELECT 1 FROM agent_runs r
                       WHERE r.agent_key = 'concall-insights' AND r.subject_ref = d.id) AS "alreadyRead"
         FROM documents d
         JOIN LATERAL (
           SELECT body FROM document_versions
            WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
         ) v ON true
        WHERE d.company_id = $1 AND d.kind = 'transcript' AND d.archived_at IS NULL
          AND length(COALESCE(v.body->>'text', '')) >= $2
        ORDER BY d.created_at DESC
        LIMIT 40`,
      [companyId, MIN_TRANSCRIPT_CHARS],
    );
    return rows;
  });
}

/**
 * The floor `lib/agents/concall.ts` refuses below.
 *
 * Duplicated as a number rather than imported, and that is the lesser evil: importing `concall.ts`
 * for one constant drags `registerHandler` → `prompt.ts` → `exemplars.ts` → the 130 MB embedder
 * into whatever renders the picker, which is `v4.md §15` finding 15 and cost a `next build`.
 * `subjects.test.ts` asserts the two agree, so the duplication cannot drift silently.
 */
export const MIN_TRANSCRIPT_CHARS = 4000;

/** What this agent can be pointed at, for this company. Empty when there is nothing to offer. */
export async function subjectsFor(agentKey: string, companyId: string | null): Promise<Subject[]> {
  const kind: SubjectKind | undefined = INVOCABLE[agentKey]?.subject;
  if (kind === undefined || companyId === null) return [];
  if (kind === 'fundamentals_period') return periods(companyId);
  if (kind === 'transcript') return transcripts(companyId);
  // 'company' and 'none' need no picker: the company select above the cards is the whole choice.
  return [];
}

/**
 * Whether a subject is one this agent could legitimately be pointed at.
 *
 * The server action's check, and the reason the picker being right is not enough: a `<select>` is
 * a suggestion, and the value posted back is whatever the browser sent. Asked of the same query
 * that built the options, so the two cannot disagree.
 */
export async function isSubjectFor(
  agentKey: string,
  companyId: string | null,
  ref: string,
): Promise<boolean> {
  return (await subjectsFor(agentKey, companyId)).some((s) => s.ref === ref);
}
