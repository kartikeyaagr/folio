import {
  indexingLag,
  listAgents,
  listAlertRules,
  listNewsSources,
  listUsers,
  recentRuns,
} from '@/lib/admin.ts';
import { listRequests } from '@/lib/access-requests.ts';
import { failedRuns } from '@/lib/agents/queue.ts';
import { AppHeader, Blank, Card, Chip, Empty, Stat, StatRow, Tabs, type Tone } from '@/components/ui.tsx';

import {
  decideRequestAction,
  requeueRunAction,
  setAdminAction,
  setAgentEffortAction,
  setAgentEnabledAction,
  setAlertRuleAction,
  setDisabledAction,
  setNewsSourceAction,
} from '../../_lib/actions/admin.ts';
import { requireAdmin } from '../../_lib/session.ts';

/**
 * The admin panel.
 *
 * Everything here is a *setting* — who has access, which agents run, which feeds are polled, which
 * rules interrupt. Nothing the system observed is editable from this page: a filing says what it
 * says, and a screen that could edit one would make the whole record arguable.
 *
 * Which tab you are on lives in the URL, so a refresh lands where you were and a link to a section
 * is a link somebody can send.
 */

export const dynamic = 'force-dynamic';

const TABS = [
  ['access', 'Access'],
  ['agents', 'Agents'],
  ['ops', 'Operations'],
  ['rules', 'Rules & feeds'],
] as const;

const SEVERITY_TONE: Record<string, Tone> = { high: 'bad', medium: 'warn', low: 'neutral' };
const RUN_TONE: Record<string, Tone> = { ok: 'good', failed: 'bad', running: 'navy' };

const when = (d: Date | null): string =>
  d ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d) : '—';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const admin = await requireAdmin();
  const tab = (await searchParams).tab ?? 'access';

  const [requests, users, agents, runs, failed, rules, sources, lag] = await Promise.all([
    listRequests(),
    listUsers(),
    listAgents(),
    recentRuns(),
    failedRuns(20),
    listAlertRules(),
    listNewsSources(),
    indexingLag(),
  ]);

  const pending = requests.filter((r) => r.status === 'pending');
  const badRuns = runs.filter((r) => r.status === 'failed').length;

  return (
    <>
      <AppHeader
        title="Admin"
        subtitle={
          `${users.filter((u) => !u.disabledAt).length} accounts · ${pending.length} requests waiting` +
          (badRuns > 0 ? ` · ${badRuns} failed runs` : '')
        }
      />

      <Tabs
        bar
        current={`?tab=${tab}`}
        tabs={TABS.map(([key, label]) => [
          `?tab=${key}`,
          key === 'access' && pending.length > 0 ? `${label} (${pending.length})` : label,
        ])}
      />

      <div className="page">
        {tab === 'access' && (
          <>
            <Card title="Requests" padded={false}>
              {requests.length === 0 ? (
                <Empty>
                  Nobody has asked for access. Requests arrive from the signup page and create no
                  account until somebody here decides.
                </Empty>
              ) : (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Who</th><th>Asked</th><th>Reason</th><th>State</th><th>Decide</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <b>{r.name}</b>
                            <span className="cell-sub">{r.email}</span>
                          </td>
                          <td>{when(r.requestedAt)}</td>
                          <td className="cell-wrap">{r.note ?? <span className="muted">said nothing</span>}</td>
                          <td>
                            <Chip tone={r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'navy'}>
                              {r.status}
                            </Chip>
                            {r.decidedByName && (
                              <span className="cell-sub">
                                {r.decidedByName}
                                {r.decidedNote ? ` — ${r.decidedNote}` : ''}
                              </span>
                            )}
                          </td>
                          <td>
                            {r.status === 'pending' ? (
                              // Two forms, not two submit buttons sharing one. Approving needs no
                              // reason and refusing needs one, so the input belongs to the refusal
                              // rather than sitting between them looking optional for both.
                              <div className="form-actions">
                                <form action={decideRequestAction}>
                                  <input type="hidden" name="id" value={r.id} />
                                  <input type="hidden" name="decision" value="approved" />
                                  <button className="btn btn-sm btn-primary">Approve</button>
                                </form>
                                <form action={decideRequestAction} className="co-assign">
                                  <input type="hidden" name="id" value={r.id} />
                                  <input type="hidden" name="decision" value="rejected" />
                                  <input
                                    className="field"
                                    name="note"
                                    placeholder="Why not?"
                                    aria-label={`Reason for refusing ${r.email}`}
                                    required
                                  />
                                  <button className="btn btn-sm">Refuse</button>
                                </form>
                              </div>
                            ) : r.status === 'approved' && !r.accountExists ? (
                              // The command lives on the row, not in the toast that announced it.
                              // A flash clears itself after thirty seconds and the approver looks
                              // away; then the only record of what to run next is gone, and the
                              // request reads "approved" with no account behind it and no
                              // instruction anywhere. It disappears once the account exists.
                              <div>
                                <span className="cell-sub">Approved {when(r.decidedAt)}. Run on the VM:</span>
                                {/* The request's id, which this system minted, and nothing the
                                    applicant typed. The command used to interpolate their email
                                    and name — both straight off the public form — into a line an
                                    admin was invited to paste into a root shell; a name of
                                    `" ; curl … | sh #` made it run that instead. The job reads
                                    the address and the name from the row itself. */}
                                <code className="cell-wrap">
                                  pnpm exec tsx jobs/seed-user.ts --request {r.id}
                                </code>
                              </div>
                            ) : (
                              <span className="muted">
                                {when(r.decidedAt)}
                                {r.status === 'approved' && r.accountExists && (
                                  <span className="cell-sub">account created</span>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Accounts" padded={false}>
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr><th>Person</th><th>Role</th><th>State</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className={u.disabledAt ? 'is-off' : undefined}>
                        <td>
                          <b>{u.name}</b>
                          <span className="cell-sub">{u.email}</span>
                        </td>
                        <td>{u.isAdmin ? <Chip tone="navy">admin</Chip> : <span className="muted">member</span>}</td>
                        <td>
                          {u.disabledAt ? (
                            <Chip tone="bad">disabled</Chip>
                          ) : u.hasPassword ? (
                            <Chip tone="good">active</Chip>
                          ) : (
                            <Chip tone="warn">no password set</Chip>
                          )}
                        </td>
                        <td>
                          <div className="form-actions">
                            <form action={setAdminAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="grant" value={u.isAdmin ? '0' : '1'} />
                              <button
                                className="btn btn-sm"
                                disabled={u.id === admin.userId && u.isAdmin}
                                title={
                                  u.id === admin.userId && u.isAdmin
                                    ? 'You cannot revoke your own admin'
                                    : undefined
                                }
                              >
                                {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                              </button>
                            </form>
                            <form action={setDisabledAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="disable" value={u.disabledAt ? '0' : '1'} />
                              <button
                                className={u.disabledAt ? 'btn btn-sm' : 'btn btn-sm btn-danger'}
                                disabled={u.id === admin.userId}
                                title={u.id === admin.userId ? 'You cannot disable yourself' : undefined}
                              >
                                {u.disabledAt ? 'Re-enable' : 'Disable'}
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {tab === 'agents' && (
          <Card title="The registry" padded={false}>
            {/* Model is read-only on purpose: PRICING is a code constant, so a model chosen here
                would be a model whose cost cannot be known, and costUsd would start returning null
                for every run it made. Effort is the dial the design actually uses. */}
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr><th>Agent</th><th>Fires</th><th>Model</th><th>Effort</th><th>Running</th></tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.key} className={a.enabled ? undefined : 'is-off'}>
                      <td>
                        <b>{a.label}</b>
                        <span className="cell-sub">{a.key}</span>
                      </td>
                      <td><Chip tone="neutral">{a.trigger}</Chip></td>
                      <td>{a.model === 'none' ? <span className="muted">no model</span> : a.model}</td>
                      <td>
                        {a.model === 'none' ? (
                          <span className="muted">—</span>
                        ) : (
                          <form action={setAgentEffortAction} className="co-assign">
                            <input type="hidden" name="key" value={a.key} />
                            <select className="field" name="effort" defaultValue={a.effort ?? ''} aria-label={`Effort for ${a.label}`}>
                              <option value="">model default</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                              <option value="xhigh">xhigh</option>
                            </select>
                            <button className="btn btn-sm">Set</button>
                          </form>
                        )}
                      </td>
                      <td>
                        <form action={setAgentEnabledAction}>
                          <input type="hidden" name="key" value={a.key} />
                          <input type="hidden" name="on" value={a.enabled ? '0' : '1'} />
                          <button className={a.enabled ? 'btn btn-sm' : 'btn btn-sm btn-primary'}>
                            {a.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {tab === 'ops' && (
          <>
            {/* A stopped indexer and a caught-up one look identical everywhere else in this app —
                retrieval just answers worse. This is the one place that tells them apart, so
                nothing pending renders <Blank>, never a bare 0: elsewhere in this system a 0 is a
                measured fact, and this is the one number where that reading would be exactly
                backwards. */}
            <StatRow>
              <Stat label="Chunks indexed" value={String(lag.chunks)} />
              <Stat
                label="Pending"
                value={lag.pending > 0 ? String(lag.pending) : <Blank why="Nothing waiting to be indexed" />}
                tone={lag.pending > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Oldest pending"
                value={lag.oldestPendingAt ? when(new Date(lag.oldestPendingAt)) : <Blank why="Nothing waiting to be indexed" />}
              />
              <Stat
                label="Failed"
                value={String(lag.failed)}
                tone={lag.failed > 0 ? 'bad' : undefined}
              />
            </StatRow>

            <Card title="Ingestion runs" padded={false}>
              {/* Nothing in the application read this table before. The audit's finding was that a
                  failed job reached no human by any path: report-failure.ts wrote a row and nothing
                  ever selected from it. This is that path. */}
              {runs.length === 0 ? (
                <Empty>No job has recorded a run yet.</Empty>
              ) : (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr><th>Source</th><th>Status</th><th className="num">Items</th><th>Detail</th><th>Started</th></tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td><b>{r.source}</b></td>
                          <td><Chip tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status}</Chip></td>
                          <td className="num">{r.items ?? ''}</td>
                          <td className="cell-wrap">{r.detail ?? ''}</td>
                          <td>{when(r.startedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Failed agent runs" padded={false}>
              {failed.length === 0 ? (
                <Empty>No agent run has failed.</Empty>
              ) : (
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr><th>Agent</th><th>Failed</th><th>Why</th><th>Retry</th></tr>
                    </thead>
                    <tbody>
                      {failed.map((f) => (
                        <tr key={f.id}>
                          <td><b>{f.agentKey}</b></td>
                          <td>{when(f.finishedAt)}</td>
                          <td className="cell-wrap">{f.error ?? f.failureKind ?? ''}</td>
                          <td>
                            <form action={requeueRunAction}>
                              <input type="hidden" name="id" value={f.id} />
                              <button className="btn btn-sm">Queue again</button>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}

        {tab === 'rules' && (
          <>
            <Card title="Alert rules" padded={false}>
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr><th>Rule</th><th>Kind</th><th>Severity</th><th>Raising</th></tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.key} className={r.active ? undefined : 'is-off'}>
                        <td>
                          <b>{r.label}</b>
                          <span className="cell-sub">{r.key}</span>
                        </td>
                        <td>{r.kind}</td>
                        <td>
                          <form action={setAlertRuleAction} className="co-assign">
                            <input type="hidden" name="key" value={r.key} />
                            <select className="field" name="severity" defaultValue={r.severity} aria-label={`Severity for ${r.label}`}>
                              <option value="high">high</option>
                              <option value="medium">medium</option>
                              <option value="low">low</option>
                            </select>
                            <button className="btn btn-sm">Set</button>
                            <Chip tone={SEVERITY_TONE[r.severity] ?? 'neutral'}>{r.severity}</Chip>
                          </form>
                        </td>
                        <td>
                          <form action={setAlertRuleAction}>
                            <input type="hidden" name="key" value={r.key} />
                            <input type="hidden" name="active" value={r.active ? '0' : '1'} />
                            <button className={r.active ? 'btn btn-sm' : 'btn btn-sm btn-primary'}>
                              {r.active ? 'Stop' : 'Start'}
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="News feeds" padded={false}>
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr><th>Feed</th><th className="num">Tier</th><th>Last poll</th><th>Polling</th></tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.key} className={s.active ? undefined : 'is-off'}>
                        <td>
                          <b>{s.label}</b>
                          <span className="cell-sub">{s.key}</span>
                        </td>
                        <td className="num">{s.tier}</td>
                        <td>
                          {s.lastStatus ? (
                            <>
                              <Chip tone={s.lastStatus === 'ok' ? 'good' : 'bad'}>{s.lastStatus}</Chip>
                              <span className="cell-sub">
                                {when(s.lastPolledAt)}
                                {s.lastError ? ` — ${s.lastError}` : ''}
                              </span>
                            </>
                          ) : (
                            <span className="muted">never polled</span>
                          )}
                        </td>
                        <td>
                          <form action={setNewsSourceAction}>
                            <input type="hidden" name="key" value={s.key} />
                            <input type="hidden" name="on" value={s.active ? '0' : '1'} />
                            <button className={s.active ? 'btn btn-sm' : 'btn btn-sm btn-primary'}>
                              {s.active ? 'Stop' : 'Start'}
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
