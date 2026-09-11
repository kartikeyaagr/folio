/**
 * The gate a rule passes through before an agent ever reads it.
 *
 * `v4.md §4.3` puts the decider in the schema — *"A rule cannot enter a prompt without a name
 * against it"* — and `0050` puts the words there too: a row with `status = 'approved'` and no
 * `rule` text is refused by the database. This file is the set of operations that can move a row
 * across that line, and it is deliberately small.
 *
 * **Two origins, one gate.** A distilled candidate arrives with evidence and no instruction; an
 * authored one arrives with an instruction and no evidence. Both are candidates, and both need a
 * second act to enter a prompt. Approving your own rule is one more click for the person who wrote
 * it, and it is what makes `decided_by` a decision rather than a side effect of typing.
 *
 * Nothing here deletes. A rule that shaped an agent's output for three months is part of the
 * record of why that output looked the way it did, so withdrawal is `retired`.
 */

import { randomBytes } from 'node:crypto';

import { readTxn, writeTxn, type Client } from '../db.ts';

export class UnknownRule extends Error {}
export class RuleAlreadyDecided extends Error {}
export class RuleTextRequired extends Error {}
export class RuleReasonRequired extends Error {}

const id = (): string => randomBytes(16).toString('hex');

/** One correction that argued for a candidate, with the text of the correction itself. */
export interface Observation {
  draftId: string;
  field: string;
  distance: number;
  from: unknown;
  to: unknown;
}

export interface Candidate {
  id: string;
  agentKey: string;
  agentLabel: string;
  origin: string;
  finding: string | null;
  rule: string | null;
  createdAt: Date;
  observations: Observation[];
}

export interface StandingRule {
  id: string;
  agentKey: string;
  agentLabel: string;
  rule: string;
  origin: string;
  decidedBy: string;
  decidedAt: Date;
}

/**
 * What is waiting on a person.
 *
 * The evidence is read live out of `ai_drafts.edits` rather than copied into `rule_observations`,
 * because an accepted draft is immutable — `lockDraft` refuses a second decision — so there is
 * nothing to copy and copying it would create a second version that could drift. §7 requires this
 * to be shown: *"A candidate rule shows the three drafts and the three fields that produced it, or
 * it does not get shown."*
 */
export async function openCandidates(): Promise<Candidate[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Candidate & { observations: Observation[] | null }>(
      `SELECT r.id, r.agent_id AS "agentKey", a.label AS "agentLabel", r.origin,
              r.finding, r.rule, r.created_at AS "createdAt",
              (SELECT json_agg(json_build_object(
                        'draftId', o.draft_id, 'field', o.field,
                        'distance', o.distance::float8,
                        'from', d.edits -> o.field -> 'from',
                        'to',   d.edits -> o.field -> 'to')
                      ORDER BY o.distance DESC)
                 FROM rule_observations o
                 JOIN ai_drafts d ON d.id = o.draft_id
                WHERE o.rule_id = r.id) AS observations
         FROM prompt_rules r
         JOIN agents a ON a.key = r.agent_id
        WHERE r.status = 'candidate'
        ORDER BY r.created_at`,
    );
    return rows.map((r) => ({ ...r, observations: r.observations ?? [] }));
  });
}

/** How many candidates are waiting, for the link on `/agents`. Cheaper than fetching the evidence. */
export async function pendingRules(): Promise<number> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM prompt_rules WHERE status = 'candidate'",
    );
    return rows[0]!.n;
  });
}

/** What is in force, for the screen. `approvedRules` is what the prompt assembler reads. */
export async function standingRules(): Promise<StandingRule[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<StandingRule>(
      `SELECT r.id, r.agent_id AS "agentKey", a.label AS "agentLabel", r.rule, r.origin,
              act.label AS "decidedBy", r.decided_at AS "decidedAt"
         FROM prompt_rules r
         JOIN agents a ON a.key = r.agent_id
         JOIN actors act ON act.id = r.decided_by
        WHERE r.status = 'approved'
        ORDER BY r.agent_id, r.decided_at`,
    );
    return rows;
  });
}

/**
 * The approved rules for one agent, oldest first.
 *
 * Oldest first because a later rule is usually a refinement of an earlier one, and a model reading
 * a numbered list takes the last word as the most specific. Read by `prompt.ts` on every run.
 */
export async function approvedRules(agentKey: string): Promise<string[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ rule: string }>(
      `SELECT rule FROM prompt_rules
        WHERE agent_id = $1 AND status = 'approved'
        ORDER BY decided_at, id`,
      [agentKey],
    );
    return rows.map((r) => r.rule);
  });
}

/** A candidate held for decision. */
async function lockRule(c: Client, ruleId: string): Promise<{ status: string; rule: string | null }> {
  const { rows } = await c.query<{ status: string; rule: string | null }>(
    'SELECT status, rule FROM prompt_rules WHERE id = $1 FOR UPDATE',
    [ruleId],
  );
  const r = rows[0];
  // These two read as sentences rather than as ids because `/rules` shows them to a person: two
  // analysts with the screen open is the ordinary case, and the second one to click needs to know
  // their page is stale rather than that a hex string went missing.
  if (!r) throw new UnknownRule('That rule is not here any more. Reload the page.');
  return r;
}

/**
 * A standing rule somebody wrote, without waiting for three corrections to imply it.
 *
 * §7 part 4: *"the loop only improves when someone remembers to correct it, and sometimes you
 * already know the rule."* It lands as a candidate, like every other rule.
 */
export async function writeRule(agentKey: string, rule: string, actorId: string): Promise<string> {
  if (!rule.trim()) throw new RuleTextRequired('A rule needs a sentence in it.');
  const ruleId = id();
  await writeTxn(actorId, async (c) => {
    await c.query(
      `INSERT INTO prompt_rules (id, agent_id, origin, rule, status)
       VALUES ($1, $2, 'authored', $3, 'candidate')`,
      [ruleId, agentKey, rule.trim()],
    );
  });
  return ruleId;
}

/**
 * Approve, with the sentence that will enter the prompt.
 *
 * The text is a parameter rather than being read off the row, because for a distilled candidate
 * there is nothing on the row to read: the distiller writes a finding and never a rule. For an
 * authored one it is the author's sentence, possibly edited by whoever is signing it — which is
 * the same gesture `/review` uses on a draft, and for the same reason.
 */
export async function approveRule(ruleId: string, rule: string, actorId: string): Promise<void> {
  if (!rule.trim()) {
    throw new RuleTextRequired(
      'An approved rule is the sentence an agent reads. A finding is evidence, not an instruction.',
    );
  }
  await writeTxn(actorId, async (c) => {
    const r = await lockRule(c, ruleId);
    if (r.status !== 'candidate') {
      throw new RuleAlreadyDecided(`Somebody already ${r.status} this one. Reload to see where it went.`);
    }
    await c.query(
      `UPDATE prompt_rules
          SET status='approved', rule=$1, decided_by=$2, decided_at=now()
        WHERE id=$3`,
      [rule.trim(), actorId, ruleId],
    );
  });
}

/**
 * Refuse a candidate. A reason is required, and the database agrees.
 *
 * A refused candidate is the row a future reader most needs explained: the hotspot that produced
 * it is still on `/agents`, still counting up, and without a note the next person re-litigates it.
 */
export async function rejectRule(ruleId: string, note: string, actorId: string): Promise<void> {
  if (!note.trim()) {
    throw new RuleReasonRequired(
      'Refusing a candidate needs a reason — the corrections behind it do not go away.',
    );
  }
  await writeTxn(actorId, async (c) => {
    const r = await lockRule(c, ruleId);
    if (r.status !== 'candidate') {
      throw new RuleAlreadyDecided(`Somebody already ${r.status} this one. Reload to see where it went.`);
    }
    await c.query(
      `UPDATE prompt_rules
          SET status='rejected', decided_by=$1, decided_at=now(), decided_note=$2
        WHERE id=$3`,
      [actorId, note.trim(), ruleId],
    );
  });
}

/**
 * Withdraw a rule that is in force. It leaves the prompt and stays in the record.
 *
 * The decider is overwritten deliberately: the question this row is asked later is "who decided
 * this rule is not in force", and the approval before it is in `audit_log` with its own name and
 * timestamp. A column that kept the approver would answer a question nobody asks with a name that
 * looks like the answer to the one they did.
 */
export async function retireRule(ruleId: string, note: string, actorId: string): Promise<void> {
  if (!note.trim()) {
    throw new RuleReasonRequired('Withdrawing a rule needs a reason — it changed what an agent wrote.');
  }
  await writeTxn(actorId, async (c) => {
    const r = await lockRule(c, ruleId);
    if (r.status !== 'approved') {
      throw new RuleAlreadyDecided(`That rule is ${r.status}, not in force. Reload the page.`);
    }
    await c.query(
      `UPDATE prompt_rules
          SET status='retired', decided_by=$1, decided_at=now(), decided_note=$2
        WHERE id=$3`,
      [actorId, note.trim(), ruleId],
    );
  });
}
