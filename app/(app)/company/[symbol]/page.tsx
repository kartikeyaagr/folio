import Link from 'next/link';
import { notFound } from 'next/navigation';

import { companyPage, priceHistory } from '@/lib/company-view.ts';
import { coverers, sectorsWithTerms, STATUSES } from '@/lib/companies.ts';
import { ACCEPTED } from '@/lib/import/index.ts';
import { AUTHORED, documentsFor, KIND_LABEL } from '@/lib/workspace.ts';
import { filedFor, heldNotListed, periodName, type FiledDocument } from '@/lib/files.ts';
import {
  AppHeader, Blank, Card, Chip, dayMonthYear, Empty, Fact, Facts, Seg, crore, inr, type Tone,
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

/**
 * A date without a time. A document was released on a day, not at 14:32 — the exchange's timestamp
 * is when its server accepted the upload, and printing it implies a precision the filing has not
 * got.
 */
const day = (d: Date | string): string =>
  dayMonthYear(typeof d === 'string' ? new Date(`${d}T00:00:00+05:30`) : d);

/**
 * One filed document as the page shows it: a one-word name, the date the company released it, and
 * a link to the PDF itself rather than to this system's reading of it.
 *
 * An annual report has no release date to show — it arrives from `/api/annual-reports`, which
 * carries a financial year and no announcement — so it says the year, which is what it is about.
 * An imported file has neither and says when it was brought in, labelled as that.
 */
function asRow(f: FiledDocument) {
  const fy = f.financialYear;
  return {
    key: f.sha,
    label: periodName(f.kind, f.releasedOn),
    at: new Date(f.releasedOn ?? (fy ? `${fy}-04-01` : f.addedOn)).getTime(),
    when: f.releasedOn ? day(f.releasedOn) : fy ? `FY${fy}-${String(Number(fy) + 1).slice(2)}` : null,
    note: `${(f.bytes / 1e6).toFixed(1)} MB` + (f.copies > 1 ? ` · ${f.copies} filed` : ''),
    dated: fy ? 'The financial year it reports on' : 'Released by the exchange',
    href: `/api/attachment/${f.sha}`,
    external: true,
    added: f.addedOn,
    readable: f.readable,
    doc: null,
  };
}

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
  searchParams: Promise<{ archived?: string }>;
}) {
  await requireUser();
  const { symbol } = await params;
  const co = await companyPage(symbol);
  if (!co) notFound();

  const sp = await searchParams;
  const showArchived = sp.archived === '1';

  const [prices, desk, sectors, written, filed, notListed] = await Promise.all([
    priceHistory(co.id),
    coverers(),
    sectorsWithTerms(),
    documentsFor(co.id, { archived: showArchived }),
    filedFor(co.id),
    heldNotListed(co.id),
  ]);

  // **A document promoted from an attachment is not a second document.** `extractPending` writes a
  // transcript's text into a `documents` row so agent 2 has something to sweep; `filedFor` lists
  // the PDF that text came out of. Listing both is the same document twice, and the one worth
  // opening is the one the company actually published.
  const docs = written.filter((d) => d.fromAttachment === null);
  const rows = [
    ...filed.map(asRow),
    ...docs.map((d) => ({
      key: d.id,
      label: d.title,
      at: d.documentDate.getTime(),
      when: day(d.documentDate),
      // Written here, so the date is the last save. `documents.updated_at` moves when the row is
      // touched rather than when somebody wrote in it; the version's own timestamp does not.
      dated: 'Last saved here',
      note: `${d.versions} ${d.versions === 1 ? 'version' : 'versions'}`,
      href: `/doc/${d.id}`,
      external: false,
      added: null,
      // Written here, so there is nothing to have failed to read.
      readable: true,
      doc: d,
    })),
  ].sort((a, b) => b.at - a.at);

  // One builder for every link on the page. The chart's range left the URL on 17-Sep-2026 — it is
  // component state now, see components/PriceChart.tsx — so `archived` is the only thing here, and
  // this stays a builder rather than two string literals so the next bit of view state has one
  // place to be added.
  const href = (next: { archived?: string }): string => {
    const query = new URLSearchParams();
    const archived = 'archived' in next ? next.archived : (showArchived ? '1' : undefined);
    if (archived) query.set('archived', archived);
    const queryString = query.toString();
    return queryString ? `?${queryString}` : '?';
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
        Required to exit or pass a name, and kept with it.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Move</button>
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
        Puts this name in the sector-news tier. Matching starts from the next run; nothing is
        matched retrospectively.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Set</button>
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
        <button type="submit" className="btn btn-primary">Set</button>
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
                {co.sector ?? <Blank why="No sector set" />}
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
                <Blank why="No shareholding filing held, or no breakdown given" />
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
          <PriceChart history={prices} />
        </Card>

        {/* What this page is for now. The financials, filings, ownership and news that used to sit
            below are still ingested and still drive the desk, the agents and the alerts — they are
            simply not what somebody opens a company to do. The work is reading and writing, and
            until this existed that happened in Google Docs and Excel, which is the thing
            docs/specs/v2-system-map.md says in its first paragraph that this system replaces. */}
        <Card
          title={
            <>
              Documents{' '}
              {/* Stated, not hidden. 1,098 routine intimations and 245 zips are held and searchable
                  and would bury the seventy documents anybody opens a company to read; a reader who
                  is not told they exist concludes they were never fetched. */}
              {notListed > 0 && (
                <span className="cell-note" title="Routine intimations and archives: held, searchable by the agents, not listed here">
                  · {notListed} more held
                </span>
              )}{' '}
              <Link href="/documents" className="btn btn-link">all →</Link>
            </>
          }
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
                    <button type="submit" className="btn btn-primary">Import</button>
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
                    <button type="submit" className="btn btn-primary">Create</button>
                  </div>
                </form>
              </DialogButton>
            </div>
          }
          padded={docs.length === 0}
        >
          {rows.length === 0 ? (
            <Empty>
              {showArchived
                ? 'Nothing archived for this company.'
                : `Nothing held for ${co.symbol} yet. Transcripts, decks and annual reports arrive with the backfill; notes, memos and models are written here.`}
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Document</th><th>Date</th><th /><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.doc?.archivedAt ? 'pf-void' : undefined}>
                      <td>
                        {/* A filed document opens as the PDF the company published, in a new tab.
                            `target` only on those: a note opens in place like every other page. */}
                        <Link
                          href={r.href}
                          {...(r.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                        >
                          <b>{r.label}</b>
                        </Link>
                      </td>
                      {/* One column, two facts, and the cell says which. A document the exchange
                          published is dated when it was released; one written here is dated when it
                          was last saved. A header claiming either over the whole table is a lie
                          about half of it. */}
                      <td className="num" title={r.dated}>
                        {r.when ?? <Blank why={`Not published by the exchange; brought in on ${day(r.added!)}`} />}
                      </td>
                      <td className="cell-note">
                        {r.note}
                        {!r.readable && (
                          <> · <span title="No text layer: a scan. The PDF is here; the agents cannot read it.">scan</span></>
                        )}
                      </td>
                      <td className="cell-note">
                        {r.doc && (
                          <div className="form-actions">
                            <form action={archiveDocumentAction}>
                              <input type="hidden" name="id" value={r.doc.id} />
                              <input type="hidden" name="symbol" value={co.symbol} />
                              {r.doc.archivedAt && <input type="hidden" name="restore" value="1" />}
                              <button type="submit" className="btn btn-link">
                                {r.doc.archivedAt ? 'Restore' : 'Archive'}
                              </button>
                            </form>
                            <DeleteDocument
                              id={r.doc.id}
                              title={r.doc.title}
                              versions={r.doc.versions}
                              symbol={co.symbol}
                            />
                          </div>
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
