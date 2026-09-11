import Link from 'next/link';

import { pendingDrafts } from '@/lib/agents/review.ts';
import { Brief } from '@/components/Brief.tsx';
import { AppHeader, Blank, Card, Chip, Empty, Eyebrow } from '@/components/ui.tsx';

import { accept, reject } from '../../_lib/actions/review.ts';
import { requireUser } from '../../_lib/session.ts';

/**
 * The review gate — the best-designed thing in v2, and the one part of it that survives whole.
 *
 * **Nothing an agent writes enters the record without a person accepting it.** Two things make that
 * more than a button. Every draft shows its sources before it shows its content, so a reader sees
 * what it was built from rather than only what it concluded. And where a deterministic check exists,
 * both readings are shown and neither is corrected — the model does not get to overwrite a filed
 * figure, and the filed figure does not get to hide that the model read something else.
 */

export const dynamic = 'force-dynamic';

/**
 * One source, as a line rather than as JSON.
 *
 * Only the plain `{kind, ref}` shape is unwrapped, and that narrowness is deliberate: agents 1, 2
 * and 6 carry extra fields on theirs — a period, a count of filings — and stringifying those whole
 * is still the most honest rendering available until somebody designs a real one. What changed is
 * that a chat draft can cite a dozen passages, and a dozen lines of `{"ref":"2742","kind":"chunk"}`
 * is provenance a reader skips, which trains exactly the waving-through this screen exists to stop.
 */
function sourceLine(s: unknown): string {
  if (s !== null && typeof s === 'object') {
    const o = s as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    if (keys.length === 2 && keys[0] === 'kind' && keys[1] === 'ref') {
      return `${String(o['kind'])} ${String(o['ref'])}`;
    }
  }
  return JSON.stringify(s);
}

/**
 * The fields, in the order the agent wrote them.
 *
 * jsonb stores keys sorted by length and then alphabetically, so a results draft rendered as
 * "moved, figures, headline" — the headline third, because eight characters is longer than five.
 * The order is captured when the draft is written; anything not in it follows, so a field added
 * later still appears.
 */
function orderedFields(
  content: Record<string, unknown>,
  order: string[] | null,
): [string, unknown][] {
  if (!order) return Object.entries(content);
  const named = order.filter((k) => k in content).map((k): [string, unknown] => [k, content[k]]);
  const rest = Object.entries(content).filter(([k]) => !order.includes(k));
  return [...named, ...rest];
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <Blank why="The agent returned nothing for this field" />;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? (
      <span className="muted">none</span>
    ) : (
      <ul className="draft-list">
        {value.map((v, i) => (
          <li key={i}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') return <pre className="draft-json">{JSON.stringify(value, null, 2)}</pre>;
  return <p className="draft-text">{String(value)}</p>;
}

export default async function ReviewPage() {
  await requireUser();
  const drafts = await pendingDrafts();

  return (
    <>
      <AppHeader
        title="Review"
        subtitle={drafts.length === 0 ? 'Nothing waiting' : `${drafts.length} waiting`}
      />

      <div className="page">
        {drafts.length === 0 ? (
          <Card title="Queue">
            <Empty>
              No drafts are waiting. An agent writes into this queue and nothing it writes reaches
              the record until somebody here accepts it.
            </Empty>
          </Card>
        ) : (
          drafts.map((d) => {
            const verified = d.verification as
              | { agreed: boolean | null; checks?: { field: string; filed: number | null; model: number | null; agreed: boolean }[]; note?: string }
              | null;
            return (
              <Card
                key={d.id}
                title={
                  <>
                    {d.agentLabel}
                    {d.symbol && (
                      <>
                        {' · '}
                        <Link href={`/company/${d.symbol}`}>{d.symbol}</Link>
                      </>
                    )}
                  </>
                }
                action={
                  <span className="draft-meta">
                    {d.model} · {d.costUsd ? `$${Number(d.costUsd).toFixed(4)}` : 'cost unknown'}
                  </span>
                }
              >
                {/*
                  Provenance first, before the content. A queue that shows conclusions and hides
                  what they were built from trains people to wave things through.
                */}
                <Eyebrow>Built from</Eyebrow>
                <ul className="draft-sources">
                  {/*
                    A draft proposed inside a thread links back to it. Everything above this line
                    says what was read; this says what was being asked, which is the half a reader
                    needs to judge whether the answer is to the right question. Null for every
                    draft an agent wrote off a sweep, which is most of them.
                  */}
                  {d.threadId && (
                    <li>
                      <Link href={`/chat?thread=${d.threadId}`}>Read the conversation →</Link>
                    </li>
                  )}
                  {d.sources.length === 0 ? (
                    <li>
                      <Blank why="This draft recorded no sources, which is itself worth asking about" />
                    </li>
                  ) : (
                    d.sources.map((s, i) => <li key={i}>{sourceLine(s)}</li>)
                  )}
                </ul>

                {verified && (
                  <>
                    <Eyebrow>
                      Checked
                      {verified.agreed === true && <Chip tone="good">agrees</Chip>}
                      {verified.agreed === false && <Chip tone="bad">disagrees</Chip>}
                      {verified.agreed === null && <Chip tone="neutral">nothing checked this</Chip>}
                    </Eyebrow>
                    {verified.checks && verified.checks.length > 0 && (
                      <div className="tbl-scroll">
                        <table className="tbl">
                          <thead>
                            <tr><th>Field</th><th className="num">Filed</th><th className="num">The agent read</th><th /></tr>
                          </thead>
                          <tbody>
                            {verified.checks.map((c) => (
                              <tr key={c.field}>
                                <td>{c.field}</td>
                                <td className="num">{c.filed ?? <Blank why="Not reported in the filing" />}</td>
                                <td className="num">{c.model ?? <Blank why="The agent did not report it" />}</td>
                                <td>
                                  {/* Both readings kept, neither corrected. */}
                                  {c.agreed ? <Chip tone="good">agrees</Chip> : <Chip tone="bad">differs</Chip>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {verified.note && <p className="hint">{verified.note}</p>}
                  </>
                )}

                <Eyebrow>What it wrote</Eyebrow>
                {/*
                  A brief is judged as the document it will become, not as its fields. The generic
                  renderer would show `by_company` as a line of JSON.stringify, and nobody can tell
                  whether a brief is any good from that — which would make the gate a formality on
                  exactly the agent whose output is longest.
                */}
                {d.agentKey === 'news-brief' ? (
                  <Brief content={d.content} />
                ) : (
                  <dl className="draft-fields">
                    {orderedFields(d.content, d.fieldOrder).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k.replace(/_/g, ' ')}</dt>
                        <dd><Value value={v} /></dd>
                      </div>
                    ))}
                  </dl>
                )}

                <div className="draft-acts">
                  <form action={accept}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" className="btn btn-primary">Accept</button>
                  </form>
                  <form action={reject} className="draft-reject">
                    <input type="hidden" name="id" value={d.id} />
                    <input
                      className="field"
                      name="reason"
                      placeholder="Why this is wrong — required"
                      aria-label="Reason for rejecting"
                    />
                    <button type="submit" className="btn btn-danger">Reject</button>
                  </form>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}
