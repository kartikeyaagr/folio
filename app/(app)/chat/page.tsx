import Link from 'next/link';

import { askedCounts, askedRuns, type AskedRun } from '@/lib/agents/history.ts';
import { INVOCABLE } from '@/lib/agents/invocable.ts';
import { pendingDraftCount } from '@/lib/agents/review.ts';
import { subjectsFor } from '@/lib/agents/subjects.ts';
import { listCompanies } from '@/lib/companies.ts';
import { readTxn } from '@/lib/db.ts';
import { AppHeader, Blank, Card, Chip, Empty, type Tone } from '@/components/ui.tsx';

import { askAgent } from '../../_lib/actions/review.ts';
import { requireUser } from '../../_lib/session.ts';

/**
 * Ask — a card per agent, and what each person has asked it for.
 *
 * Two views at one URL, because they are one thing at two depths and `?agent=` separates them. No
 * agent chosen: a grid of cards, compact enough to take in at a glance. An agent chosen: the form
 * and the history for that one.
 *
 * **There is no conversation here.** Agent 8 and its tool loop were cut on 17-Sep-2026 (`0053`), so
 * an exchange with an agent is a request and an outcome. The history shows that, and says where the
 * outcome went — a draft waiting in `/review`, or the document it became.
 *
 * **A person sees their own history; an admin sees everybody's.** The rule lives in
 * `lib/agents/history.ts`, inside the query, rather than here: a page that fetched everything and
 * rendered some of it has still sent the rest to the browser.
 *
 * State lives in the URL. A refresh lands where you were, and a link to "Ganak, pointed at PRAJIND"
 * is just a link.
 */

export const dynamic = 'force-dynamic';

interface AgentRow {
  key: string;
  label: string;
}

async function agents(): Promise<AgentRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<AgentRow>(
      'SELECT key, label FROM agents WHERE enabled AND key = ANY($1) ORDER BY key',
      [Object.keys(INVOCABLE)],
    );
    return rows;
  });
}

const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral', running: 'navy', done: 'good', failed: 'bad',
};

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

/**
 * Where a request ended up, as a link wherever there is one to give.
 *
 * The point of a history is that it closes. Somebody who asked for a forensic review last week
 * wants to know what happened to it, and "done" is not an answer — the answer is the draft, or the
 * document it became once somebody accepted it.
 */
function outcome(r: AskedRun) {
  if (r.documentId) return <Link href={`/doc/${r.documentId}`}>Accepted →</Link>;
  if (r.draftStatus === 'pending') return <Link href="/review">Waiting in Review →</Link>;
  if (r.draftStatus === 'rejected') return <span className="muted">Rejected</span>;
  if (r.status === 'failed' || r.failureKind) {
    return <span className="muted">{r.error?.slice(0, 80) ?? r.failureKind}</span>;
  }
  if (r.status === 'queued') return <span className="muted">Waiting to run</span>;
  if (r.status === 'running') return <span className="muted">Running</span>;
  return <Blank why="This run finished without writing a draft" />;
}

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; company?: string }>;
}) {
  const user = await requireUser();
  const { agent, company } = await searchParams;
  const companyId = company ?? null;
  const viewer = { userId: user.userId, isAdmin: user.isAdmin };

  const all = await agents();
  const chosen = agent && INVOCABLE[agent] ? (all.find((a) => a.key === agent) ?? null) : null;

  if (chosen === null) {
    const [counts, waiting] = await Promise.all([askedCounts(viewer), pendingDraftCount()]);
    return (
      <>
        <AppHeader
          title="Ask"
          subtitle={
            waiting === 0
              ? 'Nothing waiting in Review'
              : `${waiting} draft${waiting === 1 ? '' : 's'} waiting in Review`
          }
        />
        <div className="page">
          {all.length === 0 ? (
            <Card title="Agents"><Empty>No agent is enabled.</Empty></Card>
          ) : (
            <div className="ag-cards">
              {all.map((a) => {
                const n = counts[a.key] ?? 0;
                return (
                  <Link key={a.key} href={`/chat?agent=${a.key}`} className="ag-card">
                    <b>{a.label}</b>
                    <span className="ag-card-what">{INVOCABLE[a.key]!.what}</span>
                    <span className="ag-card-n">
                      {n === 0 ? 'Never asked' : `${n} request${n === 1 ? '' : 's'}`}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </>
    );
  }

  const spec = INVOCABLE[chosen.key]!;
  const needsPick = spec.subject === 'fundamentals_period' || spec.subject === 'transcript';
  const [names, subjects, history] = await Promise.all([
    listCompanies(),
    subjectsFor(chosen.key, companyId),
    askedRuns(viewer, chosen.key),
  ]);
  const picked = names.find((n) => n.id === companyId) ?? null;
  const blocked =
    spec.subject !== 'none' && !companyId
      ? 'Pick a company.'
      : needsPick && subjects.length === 0
        ? `Nothing to read${picked ? ` for ${picked.symbol}` : ''}.`
        : null;

  return (
    <>
      <AppHeader title={chosen.label} subtitle={spec.what} back="/chat" backTitle="Ask" />

      <div className="page">
        <Card title="Ask">
          {/* The company drives the subject picker below it, so it reloads the page into the URL. */}
          {spec.subject !== 'none' && (
            <form className="ask-company" method="get">
              <input type="hidden" name="agent" value={chosen.key} />
              <select className="field" name="company" defaultValue={companyId ?? ''} aria-label="Company">
                <option value="">Pick a company</option>
                {names.map((n) => (
                  <option key={n.id} value={n.id}>{n.symbol} — {n.name}</option>
                ))}
              </select>
              <button type="submit" className="btn">Show</button>
            </form>
          )}

          {blocked ? (
            <Empty>{blocked}</Empty>
          ) : (
            <form action={askAgent} className="ask-form">
              <input type="hidden" name="agent" value={chosen.key} />
              <input type="hidden" name="company" value={companyId ?? ''} />
              {needsPick && (
                <label className="lbl ask-pick">
                  {spec.pick}
                  <select className="field" name="subject" required>
                    {subjects.map((s) => (
                      <option key={s.ref} value={s.ref}>
                        {s.label}{s.alreadyRead ? ' · already read' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="submit" className="btn btn-primary">Ask</button>
            </form>
          )}
        </Card>

        <Card
          title={user.isAdmin ? 'Every request' : 'Your requests'}
          padded={false}
          action={user.isAdmin ? <span className="draft-meta">everybody&rsquo;s</span> : undefined}
        >
          {history.length === 0 ? (
            <div className="fl-note"><Empty>Nothing asked of this agent yet.</Empty></div>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Asked</th>
                    {user.isAdmin && <th>By</th>}
                    <th>About</th><th>State</th><th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td className="num">{IST.format(r.createdAt)}</td>
                      {/* Only rendered for an admin, who is the only one shown anybody else's. */}
                      {user.isAdmin && <td>{r.askedByMe ? <b>You</b> : r.askedBy}</td>}
                      <td className="cell-wrap">
                        {r.companySymbol && <b>{r.companySymbol}</b>}
                        {r.subjectLabel && <span className="cell-sub">{r.subjectLabel}</span>}
                        {!r.companySymbol && !r.subjectLabel && (
                          <span className="muted">Every followed name</span>
                        )}
                      </td>
                      <td><Chip tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Chip></td>
                      <td className="cell-wrap">{outcome(r)}</td>
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
