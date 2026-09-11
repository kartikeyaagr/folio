import Link from 'next/link';

import { readTxn } from '@/lib/db.ts';
import { failedRuns } from '@/lib/agents/queue.ts';
import { pendingDrafts } from '@/lib/agents/review.ts';
import { coverage, fieldHotspots, weeklyDistance } from '@/lib/agents/learning.ts';
import { pendingRules } from '@/lib/agents/rules.ts';
import { listCompanies } from '@/lib/companies.ts';
import { AppHeader, Blank, Card, Chip, Empty, Stat, StatRow, type Tone } from '@/components/ui.tsx';

import { askAgent, retryRun } from '../../_lib/actions/review.ts';
import { requireUser } from '../../_lib/session.ts';

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

export default async function AgentsPage() {
  // Kept rather than discarded: model, effort and spend are admin-only. Everything else on this
  // page is what an agent is and what it has done, which is research context anybody needs.
  const user = await requireUser();
  const [agents, drafts, failed, names, learned, weeks, hotspots, candidates] = await Promise.all([
    registry(), pendingDrafts(), failedRuns(), listCompanies(),
    coverage(), weeklyDistance(), fieldHotspots(), pendingRules(),
  ]);

  // `sum()` skips NULLs and `?? 0` turns "unknown" into "nothing", which is how v2's Fleet page
  // came to report $0.00 with a full price table missing behind it. The unpriced are counted and
  // said, and where nothing is priced at all the figure is <Blank> rather than a confident zero.
  const priced = agents.filter((a) => a.model !== 'none' && a.spend !== null);
  const unpriced = agents.filter((a) => a.model !== 'none' && a.spend === null);
  const totalSpend = priced.reduce((n, a) => n + Number(a.spend), 0);
  const prompted = agents.filter((a) => a.trigger === 'prompt' && a.enabled);

  return (
    <>
      <AppHeader
        title="Agents"
        subtitle={`${agents.length} registered · ${drafts.length} drafts waiting`}
      />

      <div className="page">
        <StatRow>
          <Stat label="Registered" value={String(agents.length)} />
          <Stat
            label="Waiting for review"
            value={String(drafts.length)}
            sub={drafts.length > 0 ? <Link href="/review">Open the queue →</Link> : 'nothing to accept'}
          />
          <Stat
            label="Failed runs"
            value={String(failed.length)}
            tone={failed.length > 0 ? 'bad' : undefined}
          />
          {user.isAdmin && (
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
                  {user.isAdmin && <><th>Model</th><th>Effort</th></>}
                  <th>Reads</th><th className="num">Runs</th><th className="num">Failed</th>
                  {user.isAdmin && <th className="num">Spend</th>}
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
                    {user.isAdmin && (
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
                    {user.isAdmin && (
                      <td className="num">
                        {a.model === 'none'
                          ? ''
                          : a.spend
                            ? `$${Number(a.spend).toFixed(4)}`
                            : <Blank why="No draft from this agent has recorded a cost yet" />}
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
                        <Blank why="This agent does not retrieve examples; acceptance still keeps them, so turning it on later starts from a corpus rather than from nothing" />
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
            <Empty>Nothing has been decided yet. The measure needs decisions before it means anything.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Agent</th>
                    <th className="num">Accepted</th>
                    <th className="num">Edited</th>
                    <th className="num">Rejected</th>
                    <th className="num">Mean distance</th>
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((w) => (
                    <tr key={`${w.week}-${w.agentKey}`}>
                      <td>{w.week}</td>
                      <td>{w.agentKey}</td>
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
                                ? 'Nothing was accepted in this week, so there is no distance to average'
                                : 'These were accepted before edit distance was recorded, so there is no figure for them'
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
            <Empty>
              No field has been corrected yet. Either the drafts have been right, or nobody has
              changed one — the counts above say which.
            </Empty>
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
                      <td>{h.field.replace(/_/g, ' ')}</td>
                      <td className="num">{h.corrections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Ask an agent">
          {prompted.length === 0 ? (
            <Empty>No prompted agents are enabled.</Empty>
          ) : (
            <div className="ask-grid">
              {prompted.map((a) => (
                <form key={a.key} action={askAgent} className="ask-form">
                  <input type="hidden" name="agent" value={a.key} />
                  <span className="ask-label">{a.label}</span>
                  <select className="field" name="company" defaultValue="" aria-label="Company">
                    <option value="">
                      {a.key === 'news-brief' ? 'Every followed name' : 'Pick a company'}
                    </option>
                    {names.map((n) => (
                      <option key={n.id} value={n.id}>{n.symbol} — {n.name}</option>
                    ))}
                  </select>
                  <button type="submit" className="btn">Ask</button>
                </form>
              ))}
            </div>
          )}
          <p className="hint">
            A prompted agent is queued here and runs on the next sweep. Its draft lands in Review,
            like every other agent&rsquo;s.
          </p>
        </Card>

        <Card title="Failed runs">
          {failed.length === 0 ? (
            <Empty>Nothing has failed.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr><th>Agent</th><th>Kind</th><th>Error</th><th>When</th><th /></tr>
                </thead>
                <tbody>
                  {failed.map((r) => (
                    <tr key={r.id}>
                      <td>{r.agentKey}</td>
                      <td>
                        {/*
                          The four named failure states. "error" is the only one that means an
                          unknown cause; the rest say exactly what went wrong.
                        */}
                        <Chip tone={r.failureKind === 'refusal' ? 'warn' : 'bad'}>
                          {r.failureKind ?? 'unknown'}
                        </Chip>
                      </td>
                      <td className="cell-wrap">{r.error ?? <Blank why="Failed with no error recorded" />}</td>
                      <td className="num">{r.finishedAt ? r.finishedAt.toISOString().slice(0, 16).replace('T', ' ') : ''}</td>
                      <td>
                        <form action={retryRun}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="btn btn-quiet btn-sm">Run again</button>
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
