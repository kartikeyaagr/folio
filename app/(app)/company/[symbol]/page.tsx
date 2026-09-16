import Link from 'next/link';
import { notFound } from 'next/navigation';

import { companyPage } from '@/lib/company-view.ts';
import { coverers, sectorsWithTerms, STATUSES } from '@/lib/companies.ts';
import { isRange, priceSeries, type Range } from '@/lib/prices.ts';
import { ACCEPTED } from '@/lib/import/index.ts';
import { AUTHORED, documentsFor, KIND_LABEL } from '@/lib/workspace.ts';
import {
  AppHeader, Blank, Card, Chip, Empty, Fact, Facts, Seg, crore, inr, type Tone,
} from '@/components/ui.tsx';
import { PriceChart } from '@/components/PriceChart.tsx';
import { DeleteDocument } from '@/components/DeleteDocument.tsx';
import { DialogButton } from '@/components/DialogButton.tsx';

import { requireUser } from '../../../_lib/session.ts';
import {
  setCoverageAction, setSectorAction, setStatusAction,
} from '../../../_lib/actions/companies.ts';
import {
  archiveDocumentAction, createDocumentAction, importFileAction,
} from '../../../_lib/actions/workspace.ts';

/**
 * One company: what it is, what it has done, and what this desk has written about it.
 *
 * **Not a screener.** The financials, filings, ownership and news that used to fill this page are
 * still ingested and still drive the desk, the agents and the alerts — they were simply not what
 * anybody opens a company to *do*. The work is reading and writing, and until now that happened in
 * Google Docs and Excel, which `docs/specs/v2-system-map.md` says in its first paragraph is the
 * thing this system exists to replace.
 */

export const dynamic = 'force-dynamic';

/** A timestamp as a person says it. The same shape `/admin` uses for the same reason. */
const when = (d: Date | null): string =>
  d === null
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(d);

/** The taxonomy's categories, in words a reader uses. */

const STATUS_TONE: Record<string, Tone> = {
  holding: 'good', working: 'navy', watching: 'neutral', exited: 'warn', passed: 'neutral',
};

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  // Both live in the URL, so a refresh lands where you were and a link to "PRAJIND consolidated,
  // yearly" is a link somebody can send.
  searchParams: Promise<{ range?: string; archived?: string }>;
}) {
  await requireUser();
  const { symbol } = await params;
  const co = await companyPage(symbol);
  if (!co) notFound();

  const sp = await searchParams;
  const range: Range = isRange(sp.range) ? sp.range : '1y';
  const showArchived = sp.archived === '1';

  const [prices, desk, sectors, docs] = await Promise.all([
    priceSeries(co.id, range),
    coverers(),
    sectorsWithTerms(),
    documentsFor(co.id, { archived: showArchived }),
  ]);

  // One builder for every link on the page, so changing the range does not silently drop the
  // archived filter and a link carries the whole view rather than half of it.
  const href = (next: { range?: string; archived?: string }): string => {
    const q = new URLSearchParams();
    q.set('range', next.range ?? range);
    const archived = 'archived' in next ? next.archived : (showArchived ? '1' : undefined);
    if (archived) q.set('archived', archived);
    return `?${q.toString()}`;
  };

  const latest = co.shareholding[0];
  const value =
    co.quantity && co.lastClose ? Number(co.quantity) * Number(co.lastClose) : null;

  // A5. Both of these existed in lib/companies.ts with no caller, so every name sat at `watching`
  // with nobody covering it — and neither gap announced itself: a status nobody can change looks
  // like a status nobody has changed, and "tell everyone" is what alert routing does when coverage
  // is null, which is indistinguishable from routing that works.
  const statusForm = (
    <form action={setStatusAction} className="form-grid">
      <input type="hidden" name="companyId" value={co.id} />
      <input type="hidden" name="symbol" value={co.symbol} />
      <label className="lbl">
        Status
        <select className="field" name="status" defaultValue={co.status}>
          {STATUSES.map((st) => (
            <option key={st} value={st}>{st}</option>
          ))}
        </select>
      </label>
      <label className="lbl">
        Why
        <input className="field" name="reason" defaultValue={co.closedReason ?? ''} />
      </label>
      {/* Said before the refusal rather than after it. A8's graveyard is only worth having if the
          reasons are in it, so exiting or passing without one is refused server-side. */}
      <p className="picker-none">
        Required to exit or pass a name, and kept: a graveyard without reasons teaches nothing.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Move it</button>
      </div>
    </form>
  );

  const sectorForm = (
    <form action={setSectorAction} className="form-grid">
      <input type="hidden" name="companyId" value={co.id} />
      <input type="hidden" name="symbol" value={co.symbol} />
      <label className="lbl">
        Sector
        <select className="field" name="sector" defaultValue={co.sector ?? ''}>
          <option value="">None — out of the sector-news tier</option>
          {sectors.map((s) => (
            <option key={s.sector} value={s.sector}>
              {s.sector} — {s.terms} terms
            </option>
          ))}
        </select>
      </label>
      {/* Only sectors with vocabulary are offered, and the term count says how much. A sector
          nobody has written terms for matches nothing, so tagging a name with it would look
          answered and behave exactly like the blank it replaced. */}
      <p className="picker-none">
        This is what puts a name in the sector-news tier: a story with none of its terms, from an
        Indian source, still reaches it. Nothing matches retrospectively — the next run onward.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Set it</button>
      </div>
    </form>
  );

  const coverForm = (
    <form action={setCoverageAction} className="form-grid">
      <input type="hidden" name="companyId" value={co.id} />
      <input type="hidden" name="symbol" value={co.symbol} />
      <label className="lbl">
        Covered by
        <select className="field" name="userId" defaultValue={co.coveredBy ?? ''}>
          <option value="">Nobody — alerts go to everyone</option>
          {desk.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Set it</button>
      </div>
    </form>
  );

  return (
    <>
      <AppHeader
        title={co.symbol}
        subtitle={`${co.name}${co.sector ? ` · ${co.sector}` : ''}${co.isin ? ` · ${co.isin}` : ''}`}
        back="/companies"
        backTitle="Companies"
      />

      <div className="page">
        <Facts>
          <Fact
            label="Status"
            value={
              <span className="form-actions">
                <Chip tone={STATUS_TONE[co.status] ?? 'neutral'}>{co.status}</Chip>
                <DialogButton
                  label="Change"
                  title={`${co.symbol} — where it stands`}
                  className="btn btn-link"
                >
                  {statusForm}
                </DialogButton>
              </span>
            }
          />
          <Fact
            label="Sector"
            value={
              <span className="form-actions">
                {co.sector ?? <Blank why="Out of the sector-news tier until one is set" />}
                <DialogButton
                  label="Change"
                  title={`${co.symbol} — what it does`}
                  className="btn btn-link"
                >
                  {sectorForm}
                </DialogButton>
              </span>
            }
          />
          <Fact
            label="Covered by"
            value={
              <span className="form-actions">
                {co.coveredByName ?? <Blank why="Alerts go to everyone" />}
                <DialogButton
                  label="Change"
                  title={`${co.symbol} — whose name it is`}
                  className="btn btn-link"
                >
                  {coverForm}
                </DialogButton>
              </span>
            }
          />
          <Fact
            label="Held"
            value={co.quantity && Number(co.quantity) > 0 ? inr(co.quantity, 0) : <Blank why="Not on the book" />}
          />
          <Fact label="Average cost" value={co.avgCost && Number(co.quantity ?? 0) > 0 ? inr(co.avgCost) : <Blank why="Not on the book" />} />
          <Fact label="Position" value={value ? crore(value) : <Blank why="Needs a holding and a close" />} />
          <Fact
            label="Promoter"
            value={latest?.promoterPct ? `${Number(latest.promoterPct).toFixed(2)}%` : <Blank why="No shareholding filing held" />}
          />
          <Fact
            label="Pledged"
            // The number is a share of the promoter's holding, not of the company. The label alone
            // cannot carry that, so the title does.
            value={
              latest?.pledgePct !== null && latest?.pledgePct !== undefined ? (
                <span title="As a percentage of the promoter holding, not of the company. That is how the exchange reports it and how the market quotes it.">
                  {Number(latest.pledgePct).toFixed(2)}%
                </span>
              ) : (
                <Blank why="No shareholding filing held, or the company declared an encumbrance it did not break down" />
              )
            }
          />
        </Facts>

        {co.closedReason && (
          <p className="notice">
            {co.status === 'exited' ? 'Exited' : 'Passed'}: {co.closedReason}
          </p>
        )}

        <Card title="Price">
          <PriceChart series={prices} href={(r) => href({ range: r })} />
        </Card>

        {/* What this page is for now. The financials, filings, ownership and news that used to sit
            below are still ingested and still drive the desk, the agents and the alerts — they are
            simply not what somebody opens a company to do. The work is reading and writing, and
            until this existed that happened in Google Docs and Excel, which is the thing
            docs/specs/v2-system-map.md says in its first paragraph that this system replaces. */}
        <Card
          title={<>Documents and models <Link href="/documents" className="btn btn-link">all →</Link></>}
          action={
            <div className="form-actions">
              <Seg
                current={href({})}
                options={[
                  { label: 'Current', href: href({ archived: undefined }) },
                  { label: 'Archived', href: href({ archived: '1' }) },
                ]}
                small
              />
              <DialogButton label="Import" title={`Import into ${co.symbol}`} className="btn btn-sm">
                <form action={importFileAction} className="form-grid">
                  <input type="hidden" name="companyId" value={co.id} />
                  <label className="lbl">
                    File
                    <input className="field" type="file" name="file" accept={ACCEPTED} required />
                  </label>
                  {/* Said before it happens, because what survives an import is the question
                      somebody uploading a model actually has. */}
                  <p className="picker-none">
                    Excel, Word, PDF, CSV and plain text. A workbook arrives whole — every tab on
                    one spreadsheet, still reading each other, so <code>=Inputs!B4</code> goes on
                    working. A formula is kept live where this system can evaluate it; where it
                    cannot, the cell holds the value Excel last showed rather than a broken formula.
                  </p>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary">Import it</button>
                  </div>
                </form>
              </DialogButton>
              <DialogButton label="New" title={`New in ${co.symbol}`} className="btn btn-primary btn-sm">
                <form action={createDocumentAction} className="form-grid">
                  <input type="hidden" name="companyId" value={co.id} />
                  <label className="lbl">
                    Title
                    <input className="field" name="title" required autoFocus />
                  </label>
                  <label className="lbl">
                    Kind
                    <select className="field" name="kind" defaultValue="note">
                      {AUTHORED.map((k) => (
                        <option key={k} value={k}>{KIND_LABEL[k]}</option>
                      ))}
                    </select>
                  </label>
                  <p className="picker-none">
                    A spreadsheet can read this system’s own figures —
                    <code> =FIN(&quot;{co.symbol}&quot;,&quot;revenue&quot;,&quot;FY26&quot;)</code> — so a
                    model moves when the next quarter lands instead of ageing quietly.
                  </p>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary">Create it</button>
                  </div>
                </form>
              </DialogButton>
            </div>
          }
          padded={docs.length === 0}
        >
          {docs.length === 0 ? (
            <Empty>
              {showArchived
                ? 'Nothing archived for this company.'
                : `Nothing written on ${co.symbol} yet. Notes, memos, meeting records and models live here, versioned and attributed like everything else.`}
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Title</th><th>Kind</th><th className="num">Versions</th>
                    <th>Last saved</th><th>By</th><th />
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} className={d.archivedAt ? 'pf-void' : undefined}>
                      <td>
                        <Link href={`/doc/${d.id}`}><b>{d.title}</b></Link>
                      </td>
                      <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                      <td className="num">{d.versions}</td>
                      <td className="num">{when(d.updatedAt)}</td>
                      <td>{d.updatedByName ?? <Blank why="Written before saves were attributed" />}</td>
                      <td className="cell-note">
                        <div className="form-actions">
                          <form action={archiveDocumentAction}>
                            <input type="hidden" name="id" value={d.id} />
                            <input type="hidden" name="symbol" value={co.symbol} />
                            {d.archivedAt && <input type="hidden" name="restore" value="1" />}
                            <button type="submit" className="btn btn-link">
                              {d.archivedAt ? 'Restore' : 'Archive'}
                            </button>
                          </form>
                          <DeleteDocument
                            id={d.id}
                            title={d.title}
                            versions={d.versions}
                            symbol={co.symbol}
                          />
                        </div>
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
