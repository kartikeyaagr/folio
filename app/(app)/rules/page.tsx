import { readTxn } from '@/lib/db.ts';
import { openCandidates, standingRules, type Observation } from '@/lib/agents/rules.ts';
import { MIN_DISTANCE, MIN_OBSERVATIONS } from '@/lib/agents/distil.ts';
import { AppHeader, Card, Chip, Empty, Eyebrow } from '@/components/ui.tsx';

import { approve, propose, refuse, retire } from '../../_lib/actions/rules.ts';
import { requireUser } from '../../_lib/session.ts';

export const dynamic = 'force-dynamic';

/**
 * What a person tells an agent, and what asked them to.
 *
 * `v4.md §7` parts 3 and 4, which are two halves of one screen. A **distilled** candidate arrives
 * with evidence and no instruction — the distiller measures and declines to interpret, because
 * *"a generated paragraph reads better and cannot be checked"*. An **authored** one arrives with
 * an instruction and no evidence, because sometimes you already know the rule.
 *
 * Both are candidates, and neither reaches a prompt until somebody types a sentence and signs it.
 * The database holds both halves of that: `prompt_rules_decided` requires the name,
 * `prompt_rules_approved_has_text` requires the sentence.
 *
 * A hub of its own would be a seventh rail destination; this lives under Agents, beside `/review`,
 * and is reached from the hotspots card that is literally the distiller's input.
 */

/** The agents a rule can be written for: the ones that read a prompt at all. */
async function writableAgents(): Promise<{ key: string; label: string }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ key: string; label: string }>(
      "SELECT key, label FROM agents WHERE model <> 'none' ORDER BY key",
    );
    return rows;
  });
}

/** A corrected value as something readable. Strings as they are; anything else as its JSON. */
function text(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2);
}

/**
 * The three drafts and the three fields, as §7 requires — *"or it does not get shown"*.
 *
 * The correction itself is here and not just its distance, because a distance is a number somebody
 * has to take on trust and the point of this screen is that they should not have to.
 */
function Evidence({ observations }: { observations: Observation[] }) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Field</th>
            <th className="num">Distance</th>
            <th>What the agent wrote</th>
            <th>What was signed off</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((o) => (
            <tr key={`${o.draftId}-${o.field}`}>
              <td>{o.field.replace(/_/g, ' ')}</td>
              <td className="num">{o.distance.toFixed(3)}</td>
              <td className="cell-wrap">
                <div className="rule-was">{text(o.from)}</div>
              </td>
              <td className="cell-wrap">
                <div className="rule-now">{text(o.to)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RulesPage() {
  await requireUser();
  const [candidates, inForce, agents] = await Promise.all([
    openCandidates(),
    standingRules(),
    writableAgents(),
  ]);

  return (
    <>
      <AppHeader
        title="Rules"
        subtitle={`${candidates.length} waiting on a decision · ${inForce.length} in force`}
        back="/agents"
        backTitle="Agents"
      />

      <div className="page">
        {/*
          A Card per candidate, the same shape /review gives a draft — because it is the same
          gesture: read the evidence, correct the text, sign it or refuse it with a reason.
        */}
        {candidates.length === 0 ? (
          <Card title="Waiting on a decision">
            <Empty>
              Nothing is waiting. A field has to be corrected {MIN_OBSERVATIONS} times, by{' '}
              {MIN_DISTANCE} or more each, before it raises a candidate — and you can write a rule
              below without waiting for that.
            </Empty>
          </Card>
        ) : (
          candidates.map((r) => (
            <Card
              key={r.id}
              title={r.agentLabel}
              action={<Chip tone={r.origin === 'authored' ? 'navy' : 'neutral'}>{r.origin}</Chip>}
            >
              {/*
                The finding is arithmetic and says so. It is deliberately not a rule: §7 forbids a
                model from writing one of these, and a mechanical sentence that looked like an
                instruction would be worse than one that does not, because it would get approved.
              */}
              {r.finding && <p className="rule-finding">{r.finding}</p>}
              {r.observations.length > 0 && (
                <>
                  <Eyebrow>The corrections that asked for it</Eyebrow>
                  <Evidence observations={r.observations} />
                </>
              )}

              <form id={`approve-${r.id}`} action={approve} className="rule-write">
                <input type="hidden" name="id" value={r.id} />
                <label className="ask-label" htmlFor={`rule-${r.id}`}>
                  The rule this agent will be given
                </label>
                <textarea
                  id={`rule-${r.id}`}
                  className="field draft-edit"
                  name="rule"
                  rows={3}
                  defaultValue={r.rule ?? ''}
                  placeholder="One instruction, in the words you would use to tell a new analyst"
                />
              </form>

              <div className="draft-acts">
                <button type="submit" form={`approve-${r.id}`} className="btn btn-primary">
                  Approve
                </button>
                {/* Two forms, not two submits sharing one: approving needs the sentence and
                    refusing needs the reason, and neither input should look optional for both. */}
                <form action={refuse} className="draft-reject">
                  <input type="hidden" name="id" value={r.id} />
                  <input
                    className="field"
                    name="note"
                    placeholder="Why this is not a rule — required"
                    aria-label="Reason for refusing"
                    required
                  />
                  <button type="submit" className="btn btn-danger">
                    Refuse
                  </button>
                </form>
              </div>
            </Card>
          ))
        )}

        <Card title="Write a rule">
          <form action={propose} className="rule-propose">
            <label className="ask-label" htmlFor="new-rule-agent">
              Agent
            </label>
            <select id="new-rule-agent" className="field" name="agent" required>
              {agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label} — {a.key}
                </option>
              ))}
            </select>
            <label className="ask-label" htmlFor="new-rule">
              The rule
            </label>
            <textarea
              id="new-rule"
              className="field draft-edit"
              name="rule"
              rows={3}
              placeholder="For SME names, always state whether the shareholding filing is within the 21-day window"
              required
            />
            <button type="submit" className="btn">
              Write it
            </button>
          </form>
          <p className="hint">
            It lands above as a candidate, not in the prompt. Approving is a second act on purpose —
            that is what puts a name and a date against a rule an agent is about to be given, and
            with three of you that name can be your own.
          </p>
        </Card>

        <Card title="In force" padded={false}>
          {inForce.length === 0 ? (
            <Empty>
              No rule has been approved yet, so every agent is running on its purpose and its
              examples alone.
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Rule</th>
                    <th>Signed by</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inForce.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.agentLabel}
                        <div className="cell-sub">{r.origin}</div>
                      </td>
                      <td className="cell-wrap">{r.rule}</td>
                      <td>{r.decidedBy}</td>
                      <td>{r.decidedAt.toLocaleDateString('en-IN')}</td>
                      <td>
                        <form action={retire} className="draft-reject">
                          <input type="hidden" name="id" value={r.id} />
                          <input
                            className="field"
                            name="note"
                            placeholder="Why it is going — required"
                            aria-label={`Reason for withdrawing the rule for ${r.agentLabel}`}
                            required
                          />
                          <button type="submit" className="btn btn-quiet btn-sm">
                            Withdraw
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
