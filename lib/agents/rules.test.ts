/**
 * Distillation, and the gate a rule passes through.
 *
 * The distances in here were **measured**, not guessed, and the pairs were chosen so that each one
 * tests what it claims to: R5a's distance tests were written twice with examples that scored the
 * same under both code paths and therefore distinguished nothing. The figures are in the comments
 * beside them and `lib/agents/distance.test.ts` owns the scoring itself.
 *
 * No model is called here or anywhere in R6: distillation is Levenshtein and SQL.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { distil, MIN_DISTANCE, MIN_OBSERVATIONS } from './distil.ts';
import {
  approvedRules,
  approveRule,
  openCandidates,
  pendingRules,
  rejectRule,
  retireRule,
  RuleAlreadyDecided,
  RuleReasonRequired,
  RuleTextRequired,
  standingRules,
  writeRule,
} from './rules.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_rules_${process.pid}`;
const ME = 'p1';
const CO = 'c1';
const AGENT = 'concall-insights';

/** 0.538 at word level. Comfortably a rewrite, not a tidy-up. */
const WROTE = 'Management guided to eighteen percent revenue growth for the full year ahead';
const SIGNED = 'Management guided to twelve percent revenue growth and flagged a weak first half';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','Tester')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [CO]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    // Order matters: rule_observations references both of the tables below it, with no cascade.
    await c.query('DELETE FROM rule_observations');
    await c.query('DELETE FROM prompt_rules');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

/** An accepted draft in which somebody changed one field. */
async function corrected(
  field: string,
  from: unknown,
  to: unknown,
  agentKey = AGENT,
): Promise<string> {
  return serviceTxn('system:agents', async (c) => {
    const { rows: r } = await c.query<{ id: string }>(
      `INSERT INTO agent_runs (id, agent_key, company_id)
       VALUES (md5(random()::text), $1, $2) RETURNING id`,
      [agentKey, CO],
    );
    const { rows: d } = await c.query<{ id: string }>(
      `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, model,
                              status, decided_by, decided_at, edits)
       VALUES (md5(random()::text), $1, $2, $3, $4, 'claude-opus-5',
               'accepted', $5, now(), $6) RETURNING id`,
      [
        r[0]!.id, agentKey, CO, JSON.stringify({ [field]: to }), ME,
        JSON.stringify({ [field]: { from, to } }),
      ],
    );
    return d[0]!.id;
  });
}


/** An accepted draft in which somebody changed several positions at once. */
async function correctedMany(
  edits: Record<string, { from: unknown; to: unknown }>,
  agentKey = AGENT,
): Promise<string> {
  return serviceTxn('system:agents', async (c) => {
    const { rows: r } = await c.query<{ id: string }>(
      `INSERT INTO agent_runs (id, agent_key, company_id)
       VALUES (md5(random()::text), $1, $2) RETURNING id`,
      [agentKey, CO],
    );
    const { rows: d } = await c.query<{ id: string }>(
      `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, model,
                              status, decided_by, decided_at, edits)
       VALUES (md5(random()::text), $1, $2, $3, '{}'::jsonb, 'claude-opus-5',
               'accepted', $4, now(), $5) RETURNING id`,
      [r[0]!.id, agentKey, CO, ME, JSON.stringify(edits)],
    );
    return d[0]!.id;
  });
}

const candidateFor = async (field: string): Promise<string> => {
  const cs = await openCandidates();
  const hit = cs.find((c) => c.observations.some((o) => o.field === field));
  assert.ok(hit, `no candidate for ${field}`);
  return hit.id;
};

// ---- distillation -------------------------------------------------------------------------------

test('two corrections are a coincidence and three are a pattern', async () => {
  await corrected('guidance_delta', WROTE, SIGNED);
  await corrected('guidance_delta', WROTE, SIGNED);
  assert.deepEqual(await distil(), { considered: 2, observed: 2, raised: 0 });
  assert.equal(await pendingRules(), 0);

  await corrected('guidance_delta', WROTE, SIGNED);
  const r = await distil();
  assert.equal(r.raised, 1, `${MIN_OBSERVATIONS} on one field raises exactly one candidate`);

  const [c] = await openCandidates();
  assert.equal(c!.origin, 'distilled');
  assert.equal(c!.rule, null, 'the distiller writes no rule — §7 forbids it');
  assert.match(c!.finding!, /^3 corrections across 3 drafts to guidance_delta, mean distance 0\.54\./);
  assert.equal(c!.observations.length, 3, 'and it shows the three drafts that produced it');
  assert.ok(c!.observations.every((o) => o.from === WROTE && o.to === SIGNED), 'with the corrections themselves');
});

test('a correction below the threshold is somebody fixing a full stop', async () => {
  // 0.029 — one character added to a thirty-four character string.
  const tidy = ['Guidance held at eighteen percent', 'Guidance held at eighteen percent.'] as const;
  for (let i = 0; i < 4; i++) await corrected('headline', tidy[0], tidy[1]);

  const r = await distil();
  assert.equal(r.considered, 4, 'all four are looked at');
  assert.equal(r.observed, 0, `and none is worth ${MIN_DISTANCE}`);
  assert.equal(r.raised, 0);
});

test('a correction is spent once, so a second pass over the same corpus raises nothing', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  assert.equal((await distil()).raised, 1);

  // House rule 3's shape, enforced by rule_observations' primary key rather than by a watermark:
  // the query asks "which corrections has no rule accounted for", and these three now have one.
  assert.deepEqual(await distil(), { considered: 0, observed: 0, raised: 0 });
});

test('an open candidate is not asked twice', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  await distil();
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);

  assert.equal((await distil()).raised, 0, 'the same question is already in front of somebody');
  assert.equal(await pendingRules(), 1);
});

test('refusing a candidate spends its evidence, and fresh corrections still raise a new one', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  await distil();
  await rejectRule(await candidateFor('guidance_delta'), 'The analyst was tightening prose, not correcting a fact.', ME);

  // The three that were refused stay attached to the refusal, so they cannot ask again...
  assert.equal((await distil()).raised, 0);
  // ...and three that nobody has seen can.
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  assert.equal((await distil()).raised, 1);
});

test('fields and agents are counted apart', async () => {
  await corrected('guidance_delta', WROTE, SIGNED);
  await corrected('guidance_delta', WROTE, SIGNED);
  await corrected('headline', 'Margins expanded', 'Margins contracted sharply on input costs'); // 0.732
  await corrected('guidance_delta', WROTE, SIGNED, 'news-brief');

  assert.equal((await distil()).raised, 0, 'four corrections, no field corrected three times');
});

// ---- the gate -----------------------------------------------------------------------------------

test('a candidate needs a human sentence, and the error says why', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  await distil();
  const id = await candidateFor('guidance_delta');

  await assert.rejects(() => approveRule(id, '   ', ME), RuleTextRequired);
  assert.deepEqual(await approvedRules(AGENT), [], 'and nothing reached the prompt');

  await approveRule(id, 'State the guided figure and the period it covers, or say it was not given.', ME);
  assert.deepEqual(await approvedRules(AGENT), [
    'State the guided figure and the period it covers, or say it was not given.',
  ]);
});

test('the database refuses an approved rule with no text, independently of the code that checks', async () => {
  // `approveRule` raises first so the caller gets a sentence rather than a constraint name. This
  // asserts the constraint underneath it, because that is the one that holds when somebody writes
  // a migration or a one-off UPDATE against this table.
  await assert.rejects(
    () =>
      serviceTxn('system:agents', (c) =>
        c.query(
          `INSERT INTO prompt_rules (id, agent_id, origin, finding, status, decided_by, decided_at)
           VALUES ('x', $1, 'distilled', '3 corrections', 'approved', $2, now())`,
          [AGENT, ME],
        ),
      ),
    /prompt_rules_approved_has_text/,
  );
});

test('a refusal and a withdrawal both need a reason', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  await distil();
  const id = await candidateFor('guidance_delta');

  await assert.rejects(() => rejectRule(id, '', ME), RuleReasonRequired);
  await approveRule(id, 'State the guided figure and the period it covers.', ME);
  await assert.rejects(() => retireRule(id, '  ', ME), RuleReasonRequired);
});

test('a decision is made once', async () => {
  for (let i = 0; i < 3; i++) await corrected('guidance_delta', WROTE, SIGNED);
  await distil();
  const id = await candidateFor('guidance_delta');

  await approveRule(id, 'State the guided figure.', ME);
  await assert.rejects(() => approveRule(id, 'Something else.', ME), RuleAlreadyDecided);
  await assert.rejects(() => rejectRule(id, 'changed my mind', ME), RuleAlreadyDecided);
});

test('a withdrawn rule leaves the prompt and stays in the record', async () => {
  const id = await writeRule(AGENT, 'Always name the quarter.', ME);
  await approveRule(id, 'Always name the quarter.', ME);
  assert.deepEqual(await approvedRules(AGENT), ['Always name the quarter.']);

  await retireRule(id, 'Superseded by the rule about the period it covers.', ME);
  assert.deepEqual(await approvedRules(AGENT), [], 'it is out of the prompt');
  const { rows } = await readTxn((c) =>
    c.query<{ status: string; rule: string; decided_note: string }>(
      'SELECT status, rule, decided_note FROM prompt_rules WHERE id = $1',
      [id],
    ),
  );
  assert.equal(rows[0]!.status, 'retired');
  assert.equal(rows[0]!.rule, 'Always name the quarter.', 'and still readable');
});

// ---- authored -----------------------------------------------------------------------------------

test('a rule somebody wrote is a candidate until somebody signs it', async () => {
  // §7 part 4: "Same table, same approval." Writing it is not deciding it, and that second act is
  // what puts a name and a date against a sentence an agent is about to be given.
  const id = await writeRule(AGENT, 'For SME names, say whether the filing is inside the 21-day window.', ME);

  assert.deepEqual(await approvedRules(AGENT), []);
  const [c] = await openCandidates();
  assert.equal(c!.origin, 'authored');
  assert.equal(c!.finding, null, 'an assertion needs no evidence; that is what makes it an assertion');
  assert.deepEqual(c!.observations, [], 'and it points at no drafts');

  await approveRule(id, 'For SME names, say whether the filing is inside the 21-day window.', ME);
  const [s] = await standingRules();
  assert.equal(s!.decidedBy, 'Tester');
  assert.equal(s!.origin, 'authored');
});

test('an empty rule is not a rule', async () => {
  await assert.rejects(() => writeRule(AGENT, '\n  ', ME), RuleTextRequired);
});

test('rules are numbered in the order they were signed', async () => {
  const first = await writeRule(AGENT, 'Name the quarter.', ME);
  await approveRule(first, 'Name the quarter.', ME);
  const second = await writeRule(AGENT, 'Name the quarter and the guided figure.', ME);
  await approveRule(second, 'Name the quarter and the guided figure.', ME);

  // Oldest first: a later rule is usually a refinement, and the last word should be the specific one.
  assert.deepEqual(await approvedRules(AGENT), [
    'Name the quarter.',
    'Name the quarter and the guided figure.',
  ]);
  assert.deepEqual(await approvedRules('news-brief'), [], "another agent's rules are not this one's");
});

// ---- corrections that reach inside a draft ------------------------------------------------------

const WHY = (n: number) => `by_company[${n}].why_it_matters`;

test('the same field corrected in three briefs is one pattern, wherever in each it sat', async () => {
  // The point of collapsing positions. Grouped by their literal paths these are three patterns of
  // one, none of them ever reaching three, and nothing is learned about an agent that has been
  // making the same mistake for a month.
  await corrected(WHY(0), WROTE, SIGNED);
  await corrected(WHY(4), WROTE, SIGNED);
  await corrected(WHY(2), WROTE, SIGNED);

  assert.equal((await distil()).raised, 1);
  const [c] = await openCandidates();
  assert.match(c!.finding!, /^3 corrections across 3 drafts to by_company\[\]\.why_it_matters,/);
  assert.equal(c!.observations.length, 3);
  assert.deepEqual(
    c!.observations.map((o) => o.field).sort(),
    [WHY(0), WHY(2), WHY(4)],
    'and each observation still says where it actually happened, so /rules can show the correction',
  );
});

test('a candidate already open about a field is not raised again from another position', async () => {
  // `rule_observations.field` holds the position and the guard is about the field, so comparing
  // the two raw never matches and every pass raises the same question again — which is exactly
  // what distil.ts forbids in as many words.
  for (const n of [0, 1, 2]) await corrected(WHY(n), WROTE, SIGNED);
  assert.equal((await distil()).raised, 1);

  for (const n of [7, 8, 9]) await corrected(WHY(n), WROTE, SIGNED);
  assert.equal((await distil()).raised, 0, 'the same question is already in front of somebody');
  assert.equal(await pendingRules(), 1);
});

test('many corrections in one brief is one analyst, not a pattern', async () => {
  // Before a correction could reach inside a draft, one draft could contribute at most one
  // correction per field and "three observations" and "three drafts" were the same number. A brief
  // covering twenty names can now carry twenty, and three of those is a careful morning.
  await correctedMany({
    [WHY(0)]: { from: WROTE, to: SIGNED },
    [WHY(1)]: { from: WROTE, to: SIGNED },
    [WHY(2)]: { from: WROTE, to: SIGNED },
    [WHY(3)]: { from: WROTE, to: SIGNED },
  });

  const r = await distil();
  assert.equal(r.observed, 4, 'all four are real corrections');
  assert.equal(r.raised, 0, 'and they are all one draft');

  // A second brief making the same mistake is still not three.
  await correctedMany({ [WHY(0)]: { from: WROTE, to: SIGNED } });
  assert.equal((await distil()).raised, 0);
  await correctedMany({ [WHY(0)]: { from: WROTE, to: SIGNED } });
  assert.equal((await distil()).raised, 1, 'three briefs is');
});

test('a position is still spent once, so the same correction cannot be counted twice', async () => {
  for (const n of [0, 1, 2]) await corrected(WHY(n), WROTE, SIGNED);
  await distil();
  assert.deepEqual(await distil(), { considered: 0, observed: 0, raised: 0 });
});
