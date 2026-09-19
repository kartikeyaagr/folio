/**
 * The mechanism gate.
 *
 * A candidate becomes a match only when something can state **why** the story bears on the company.
 * Not a relevance score, not a confidence number — a sentence a person can disagree with. That is
 * the whole of C4: an unexplained match trains you to distrust the next one, and a number is an
 * unexplained match wearing a hat.
 *
 * The gate is the one place in this system that is *allowed* to return nothing on a working day.
 * Every other job treats zero as a failure, because a dead feed must never look like a quiet one.
 * Here zero means the net caught nothing worth asking about, which happens often on a small book
 * and is not a fault. That exemption is deliberate and is the only one.
 *
 * Sonnet 5 at `low` effort, one call per candidate. Roughly 50-100 candidates a day against a book
 * this size, and the judgement it makes is a narrow one: read two paragraphs, name a connection or
 * say there is none.
 */

import { serviceTxn } from '../db.ts';
import { costUsd, liveModel, type Answer, type Model } from '../agents/model.ts';

export const GATE_MODEL = 'claude-sonnet-5';

/**
 * Three, then the row stops.
 *
 * Without a terminal state an expired key means every run re-attempts the same growing queue,
 * reports itself busy, and decides nothing.
 */
export const MAX_GATE_ATTEMPTS = 3;

const SYSTEM = `You judge whether a news story bears on a specific listed Indian company.

You are given the company, what it does, and one story that mentioned something associated with it.
The mention alone is not the answer — it is the reason you are being asked.

Answer with a MECHANISM or with nothing. A mechanism is a specific causal path from the story to
this company's business: a customer, a supplier, an input cost, a competitor, a regulation that
changes what it may sell or must spend, a market it operates in. "Both concern ethanol" is not a
mechanism. "The company builds ethanol plants for sugar mills, and this directive changes what
those mills may produce" is.

Say no when the connection is only vocabulary, when the story is about a different market, when it
is a conference listing or a market wrap, or when you would have to invent a fact about the company
to make the link work. Saying no is the ordinary answer and costs nothing.

Do not speculate about share price. Do not restate the headline. If the answer is yes, the
mechanism must be one or two sentences and must name the specific thing that connects them.`;

const SCHEMA = {
  type: 'object',
  properties: {
    related: { type: 'boolean' },
    mechanism: {
      type: ['string', 'null'],
      description: 'One or two sentences naming the causal path. Null when related is false.',
    },
  },
  required: ['related', 'mechanism'],
  additionalProperties: false,
};

export interface GateSubject {
  matchId: string;
  companyName: string;
  symbol: string;
  sector: string | null;
  business: string | null;
  tier: string;
  evidence: string;
  sourceLabel: string;
  title: string;
  summary: string | null;
}

export function gatePrompt(s: GateSubject): string {
  return [
    `COMPANY: ${s.companyName} (${s.symbol})`,
    s.sector ? `SECTOR: ${s.sector}` : null,
    s.business ? `WHAT IT DOES: ${s.business}` : null,
    '',
    `STORY, from ${s.sourceLabel}:`,
    s.title,
    s.summary ? `\n${s.summary}` : null,
    '',
    `IT WAS CAUGHT BY: ${s.tier} — "${s.evidence}"`,
    '',
    'Is there a mechanism connecting this story to this company?',
  ].filter((l) => l !== null).join('\n');
}

export interface GateResult {
  considered: number;
  confirmed: number;
  rejected: number;
  failed: number;
  ungated: number;
  costUsd: number;
  /**
   * Calls whose model has no price. `costUsd` is the total of what could be priced, so a run with
   * any of these is reporting a floor, not a figure — and the caller has to say so rather than
   * print a total that quietly excludes them.
   */
  unpriced: number;
}

/**
 * Judge the waiting candidates.
 *
 * Claimed one at a time with SKIP LOCKED, so two gates running never spend twice on one candidate —
 * which is the failure that costs money rather than correctness.
 */
export async function runGate(model: Model = liveModel, limit = 100): Promise<GateResult> {
  const out: GateResult = {
    considered: 0, confirmed: 0, rejected: 0, failed: 0, ungated: 0, costUsd: 0, unpriced: 0,
  };

  for (let i = 0; i < limit; i++) {
    const more = await serviceTxn('system:news-gate', async (c) => {
      const { rows } = await c.query<GateSubject & { attempts: number }>(
        `SELECT m.id AS "matchId", m.tier, m.evidence, m.attempts,
                co.name AS "companyName", co.symbol, co.sector,
                (SELECT d.title FROM documents d
                  WHERE d.company_id = co.id AND d.kind = 'memo' AND d.archived_at IS NULL
                  ORDER BY d.updated_at DESC LIMIT 1) AS business,
                s.label AS "sourceLabel", i.title, i.summary
           FROM news_matches m
           JOIN news_items i ON i.id = m.item_id
           JOIN news_sources s ON s.key = i.source_key
           JOIN companies co ON co.id = m.company_id
          WHERE m.state = 'candidate' AND m.attempts < $1
          ORDER BY m.created_at
          FOR UPDATE OF m SKIP LOCKED
          LIMIT 1`,
        [MAX_GATE_ATTEMPTS],
      );
      const subject = rows[0];
      if (!subject) return false;
      out.considered++;

      const answer: Answer = await model({
        model: GATE_MODEL,
        effort: 'low',
        system: SYSTEM,
        task: gatePrompt(subject),
        schema: SCHEMA,
        maxTokens: 2000,
      });

      if (!answer.ok) {
        const attempts = subject.attempts + 1;
        // Neither of these is a transport failure and neither comes out differently next time: a
        // refusal is a decision, and a prompt that overflowed the context window will overflow it
        // again. Both end the row now rather than burning two more calls to learn that.
        const terminal =
          attempts >= MAX_GATE_ATTEMPTS || answer.kind === 'refusal' || answer.kind === 'too_large';
        await c.query(
          `UPDATE news_matches
              SET attempts = $2, last_error = $3, state = CASE WHEN $4 THEN 'ungated' ELSE state END
            WHERE id = $1`,
          [subject.matchId, attempts, `${answer.kind}: ${answer.detail}`.slice(0, 300), terminal],
        );
        out.failed++;
        if (terminal) out.ungated++;
        return true;
      }

      // `?? 0` was a claim. `costUsd` returns null for a model this system has no price for, and
      // adding zero says the call was free — which is the one thing CLAUDE.md names about cost, and
      // the exact way v2's dashboard came to report $0.00 with confidence.
      if (answer.costUsd === null) out.unpriced++;
      else out.costUsd += answer.costUsd;
      const related = answer.content['related'] === true;
      const mechanism = typeof answer.content['mechanism'] === 'string'
        ? answer.content['mechanism'].trim()
        : null;

      // Related with no mechanism is not related. The mechanism IS the confirmation — a yes with
      // nothing behind it is the unexplained match this whole design exists to prevent.
      const confirmed = related && mechanism !== null && mechanism !== '';
      await c.query(
        `UPDATE news_matches
            SET state = $2, mechanism = $3, gated_at = now(), attempts = attempts + 1,
                last_error = NULL
          WHERE id = $1`,
        [subject.matchId, confirmed ? 'confirmed' : 'rejected', confirmed ? mechanism : null],
      );
      if (confirmed) out.confirmed++;
      else out.rejected++;
      return true;
    });
    if (!more) break;
  }

  return out;
}

/** Candidates the gate could not judge. Small, and worth someone noticing. */
export async function ungated(): Promise<{ id: string; title: string; lastError: string | null }[]> {
  return serviceTxn('system:news', async (c) => {
    const { rows } = await c.query<{ id: string; title: string; lastError: string | null }>(
      `SELECT m.id, i.title, m.last_error AS "lastError"
         FROM news_matches m JOIN news_items i ON i.id = m.item_id
        WHERE m.state = 'ungated'
        ORDER BY m.created_at DESC`,
    );
    return rows;
  });
}

export { costUsd };
