import Link from 'next/link';

import { readTxn } from '@/lib/db.ts';
import { failedRuns, MAX_ATTEMPTS } from '@/lib/agents/queue.ts';
import { pendingDraftCount } from '@/lib/agents/review.ts';
import { coverage, fieldHotspots, weeklyDistance } from '@/lib/agents/learning.ts';
import { pendingRules } from '@/lib/agents/rules.ts';
import { label } from '@/lib/agents/paths.ts';
import { AppHeader, Blank, Card, Chip, Empty, Stat, StatRow, type Tone } from '@/components/ui.tsx';

import { retryRun } from '../../_lib/actions/review.ts';
import { requireAdmin } from '../../_lib/session.ts';

/**
 * The registry, and what it has been doing.
 *
 * **An agent is a record, not a call site.** What runs, over what data, on what model, at what
 * effort, is one query — this page. An agent that exists only as code somewhere is an agent nobody
 * can answer questions about.
 *
 * Cost is shown because it is true. v2's equivalent page reported $0.00 for every run: prices lived
 * in a table nothing ever seeded, and a dashboard confidently reporting a number it cannot know is
 * worse than no dashboard. Here an unknown model gives a blank, never a zero.
 */

export const dynamic = 'force-dynamic';

interface AgentRow {
  key: string; label: string; trigger: string; model: string; effort: string | null;
  dataScope: string[]; enabled: boolean; minInterval: number | null;
  runs: number; failures: number; lastRun: Date | null; spend: string | null;
}

async function registry(): Promise<AgentRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<AgentRow>(
      `SELECT a.key, a.label, a.trigger, a.model, a.effort,
              a.data_scope AS "dataScope", a.enabled,
              a.min_interval_minutes AS "minInterval",
              (SELECT count(*)::int FROM agent_runs r WHERE r.agent_key = a.key) AS runs,
              (SELECT count(*)::int FROM agent_runs r
                WHERE r.agent_key = a.key AND r.status = 'failed') AS failures,
              (SELECT max(r.finished_at) FROM agent_runs r WHERE r.agent_key = a.key) AS "lastRun",
              (SELECT sum(d.cost_usd)::text FROM ai_drafts d WHERE d.agent_key = a.key) AS spend
         FROM agents a
        ORDER BY a.trigger, a.key`,
    );
    return rows;
  });
}

const TRIGGER_TONE: Record<string, Tone> = {
  event: 'navy', schedule: 'neutral', prompt: 'good',
};

/**
 * A timestamp as "due now" or a wall-clock time, because that is the only thing anybody does with
 * one here: decide whether to wait or to go and look at the box.
 *
 * IST, like every other date in this application. The column this replaced printed
 * `toISOString().slice(0, 16)` — UTC, unlabelled, five and a half hours behind the desk reading
 * it, which for a "will be tried again at" is the difference between waiting and not.
 */
const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});
const when = (at: Date): string => (at.getTime() <= Date.now() ? 'due now' : IST.format(at));

export default async function AgentsPage() {
  // **The whole page is admin-only now**, not just its spend column. What runs unattended, on what
  // model, at what cost, and what failed is operating detail about how the system is run — the same
  // argument migration `0030` made for the spend figures, applied to the page they were on. Asking
  // an agent for a piece of work is not operating detail, and it moved to `/chat` so an analyst who
  // cannot open this page can still ask.
  //
  // `requireAdmin` redirects rather than 404s: a person who follows a stale link should land
  // somewhere, and which pages exist is not a secret from somebody already signed in.
  await requireAdmin();
  const [agents, waiting, failed, learned, weeks, hotspots, candidates] = await Promise.all([
    registry(), pendingDraftCount(), failedRuns(),
    coverage(), weeklyDistance(), fieldHotspots(), pendingRules(),
  ]);

  // `sum()` skips NULLs and `?? 0` turns "unknown" into "nothing", which is how v2's Fleet page
  // came to report $0.00 with a full price table missing behind it. The unpriced are counted and
  // said, and where nothing is priced at all the figure is <Blank> rather than a confident zero.
  const priced = agents.filter((a) => a.model !== 'none' && a.spend !== null);
  const unpriced = agents.filter((a) => a.model !== 'none' && a.spend === null);
  const totalSpend = priced.reduce((n, a) => n + Number(a.spend), 0);

  // Two different asks, so two different lists. A retired run needs somebody; a retrying one needs
  // whatever broke the box fixed, and then nothing. Collapsing them would put the first behind the
  // second exactly when a person is scanning for the first.
  const retired = failed.filter((r) => r.retired);
  const retrying = failed.filter((r) => !r.retired);

  return (
    <>
      <AppHeader
        title="Agents"
        subtitle={`${agents.length} registered · ${waiting} draft${waiting === 1 ? '' : 's'} waiting`}
      />

      <div className="page">
        <StatRow>
          <Stat label="Registered" value={String(agents.length)} />
          <Stat
            label="Waiting for review"
            value={String(waiting)}
            sub={waiting > 0 ? <Link href="/review">Open the queue →</Link> : 'nothing to accept'}
          />
          {/*
            The total, not the retired count. Until `failedRuns` was widened this read
            `status = 'failed'` only, so three runs holding `401 … API key is invalid` and waiting
            on their next attempt showed here as **0** — the zero this codebase keeps arguing
            about, on the screen that answers "is anything broken".
          */}
          <Stat
            label="Failed runs"
            value={String(failed.length)}
            tone={failed.length > 0 ? 'bad' : undefined}
            sub={
              failed.length === 0
                ? 'nothing has failed'
                : retired.length === 0
                  ? `all waiting to be tried again`
                  : retrying.length === 0
                    ? `${retired.length} out of attempts`
                    : `${retired.length} out of attempts, ${retrying.length} waiting to be tried again`
            }
          />
          {(
            <Stat
              label="Spend to date"
              value={priced.length === 0 ? '—' : `$${totalSpend.toFixed(4)}`}
              sub={
                priced.length === 0
                  ? 'nothing priced yet'
                  : unpriced.length > 0
                    ? `${unpriced.length} agent${unpriced.length === 1 ? '' : 's'} unpriced, excluded`
                    : undefined
              }
            />
          )}
        </StatRow>

        <Card title="The registry" padded={false}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Agent</th><th>Fires</th>
                  {<><th>Model</th><th>Effort</th></>}
                  <th>Reads</th><th className="num">Runs</th><th className="num">Failed</th>
                  {<th className="num">Spend</th>}
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.key} className={a.enabled ? undefined : 'is-off'}>
                    <td>
                      <b>{a.label}</b>
                      <span className="cell-sub">{a.key}</span>
                    </td>
                    <td>
                      <Chip tone={TRIGGER_TONE[a.trigger] ?? 'neutral'}>{a.trigger}</Chip>
                      {a.minInterval && <span className="cell-sub">every {a.minInterval}m</span>}
                    </td>
                    {(
                      <>
                        <td>{a.model === 'none' ? <span className="muted">no model</span> : a.model}</td>
                        <td>{a.effort ?? <span className="muted">—</span>}</td>
                      </>
                    )}
                    <td className="cell-wrap">
                      {a.dataScope.length === 0 ? <span className="muted">nothing</span> : a.dataScope.join(', ')}
                    </td>
                    <td className="num">{a.runs || ''}</td>
                    <td className="num">{a.failures || ''}</td>
                    {(
                      <td className="num">
                        {a.model === 'none'
                          ? ''
                          : a.spend
                            ? `$${Number(a.spend).toFixed(4)}`
                            : <Blank why="No draft from this agent has recorded a cost" />}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/*
          §7's exit test, on the screen. "If mean edit distance does not fall, the loop is not
          working and should be turned off" — so the number has to be visible before anyone can act
          on it, and the trend matters rather than the level.

          Held, Retrievable and Model are three numbers because acceptance writes an exemplar for
          every model-calling agent whether or not it learns: the flag gates retrieval, so a
          non-zero Held against a non-learning agent is correct and would read as a bug if the two
          were collapsed into one.
        */}
        <Card title="What it has learned from" padded={false}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">Held</th>
                  <th className="num">Retrievable</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {learned.map((a) => (
                  <tr key={a.agentKey}>
                    <td>{a.label}</td>
                    <td className="num">{a.held}</td>
                    <td className="num">
                      {a.learning ? (
                        a.retrievable
                      ) : (
                        <Blank why="This agent does not retrieve examples. They are still kept." />
                      )}
                    </td>
                    <td>{a.model}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Accepted, edited, rejected" padded={false}>
          {weeks.length === 0 ? (
            <Empty>No draft has been accepted or rejected yet.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Agent</th>
                    <th>Measured</th>
                    <th className="num">Accepted</th>
                    <th className="num">Edited</th>
                    <th className="num">Rejected</th>
                    <th className="num">Mean distance</th>
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((w) => (
                    <tr key={`${w.week}-${w.agentKey}-${String(w.nestedEditable)}`}>
                      <td>{w.week}</td>
                      <td>{w.agentKey}</td>
                      {/*
                        Which instrument took the number, because before 0051 a reviewer could only
                        correct a top-level string — so agent 6's and agent 7's distance was
                        structurally 0 and agent 1's counted only its headline. A mean across the
                        two is a mean of two different measurements, and §7's whole test is whether
                        the number FELL. A week that spans the change appears as two rows on
                        purpose: that is what happened, and averaging them would hide it.
                      */}
                      <td>
                        {w.nestedEditable ? (
                          <span className="cell-sub">every field</span>
                        ) : (
                          <Chip tone="warn">top level only</Chip>
                        )}
                      </td>
                      <td className="num">{w.accepted}</td>
                      <td className="num">{w.edited}</td>
                      <td className="num">{w.rejected}</td>
                      <td className="num">
                        {/*
                          A mean over nothing is not zero, and 0.000 would read as "perfect". But
                          null arrives for two different reasons and saying the wrong one is its own
                          small lie: a week with no acceptances has nothing to average, while a week
                          whose acceptances all predate R5a has acceptances with no distance
                          recorded against them. The dev database showed "1 accepted" beside
                          "nothing was accepted in this week" before this told them apart.
                        */}
                        {w.meanDistance === null ? (
                          <Blank
                            why={
                              w.accepted === 0
                                ? 'Nothing was accepted this week'
                                : 'Accepted before edit distance was recorded'
                            }
                          />
                        ) : (
                          w.meanDistance.toFixed(3)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/*
          The distiller reads this table. A field here that has been corrected three times is what
          raises a candidate on /rules, so the way across lives on the card that produced it —
          the same reasoning that puts /review's link on the "waiting for review" stat.
        */}
        <Card
          title="What it keeps getting wrong"
          padded={false}
          action={
            <Link href="/rules">
              {candidates === 0
                ? 'Rules →'
                : `${candidates} rule${candidates === 1 ? '' : 's'} waiting on a decision →`}
            </Link>
          }
        >
          {hotspots.length === 0 ? (
            <Empty>No field has been corrected yet.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr><th>Agent</th><th>Field</th><th className="num">Corrected</th></tr>
                </thead>
                <tbody>
                  {hotspots.map((h) => (
                    <tr key={`${h.agentKey}-${h.field}`}>
                      <td>{h.agentKey}</td>
                      <td>{label(h.field)}</td>
                      <td className="num">{h.corrections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/*
          "Ask an agent" used to be here and is now `/chat`, the request desk. It left with the
          page's audience: this is the registry, which is admin-only, and an analyst still has to
          be able to ask for a forensic review without being able to read what the desk spends.
        */}
        <Card title="Failed runs">
          {failed.length === 0 ? (
            <Empty>Nothing has failed.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Agent</th><th>Kind</th><th>Error</th>
                    <th className="num">Attempt</th><th>What happens next</th><th />
                  </tr>
                </thead>
                <tbody>
                  {failed.map((r) => (
                    <tr key={r.id}>
                      <td>{r.agentKey}</td>
                      <td>
                        {/*
                          The six named failure states. "error" is the only one that means an
                          unknown cause; the rest say exactly what went wrong, and are properties
                          of the subject rather than of the box — which is why only `error` is ever
                          put back automatically.
                        */}
                        <Chip tone={r.failureKind === 'refusal' ? 'warn' : 'bad'}>
                          {r.failureKind ?? 'unknown'}
                        </Chip>
                      </td>
                      <td className="cell-wrap">{r.error ?? <Blank why="No error recorded" />}</td>
                      <td className="num">{r.attempts} of {MAX_ATTEMPTS}</td>
                      {/*
                        The column that was missing. A run below MAX_ATTEMPTS is `queued` with its
                        error still on it and the machine will come back to it; a retired one will
                        not be offered again by anything, and saying so is the difference between
                        a list somebody works through and a list somebody scrolls past.
                      */}
                      <td className="cell-wrap">
                        {r.retired ? (
                          <Chip tone="bad">out of attempts</Chip>
                        ) : (
                          <>
                            <Chip tone="warn">will be tried again</Chip>
                            {r.nextAttemptAt && (
                              <span className="cell-sub">{when(r.nextAttemptAt)}</span>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {/* `requeue` only matches a retired row, so the button only appears on one. */}
                        {r.retired && (
                          <form action={retryRun}>
                            <input type="hidden" name="id" value={r.id} />
                            <button type="submit" className="btn btn-quiet btn-sm">Retry</button>
                          </form>
                        )}
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
