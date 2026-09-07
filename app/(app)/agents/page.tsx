import Link from 'next/link';

import { readTxn } from '@/lib/db.ts';
import { failedRuns } from '@/lib/agents/runner.ts';
import { pendingDrafts } from '@/lib/agents/review.ts';
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
  await requireUser();
  const [agents, drafts, failed, names] = await Promise.all([
    registry(), pendingDrafts(), failedRuns(), listCompanies(),
  ]);

  const totalSpend = agents.reduce((n, a) => n + Number(a.spend ?? 0), 0);
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
          <Stat label="Spend to date" value={`$${totalSpend.toFixed(4)}`} />
        </StatRow>

        <Card title="The registry" padded={false}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Agent</th><th>Fires</th><th>Model</th><th>Effort</th>
                  <th>Reads</th><th className="num">Runs</th><th className="num">Failed</th>
                  <th className="num">Spend</th>
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
                    <td>{a.model === 'none' ? <span className="muted">no model</span> : a.model}</td>
                    <td>{a.effort ?? <span className="muted">—</span>}</td>
                    <td className="cell-wrap">
                      {a.dataScope.length === 0 ? <span className="muted">nothing</span> : a.dataScope.join(', ')}
                    </td>
                    <td className="num">{a.runs || ''}</td>
                    <td className="num">{a.failures || ''}</td>
                    <td className="num">
                      {a.model === 'none'
                        ? ''
                        : a.spend
                          ? `$${Number(a.spend).toFixed(4)}`
                          : <Blank why="No draft from this agent has recorded a cost yet" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
