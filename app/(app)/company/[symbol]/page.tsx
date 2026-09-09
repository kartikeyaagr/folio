import Link from 'next/link';
import { notFound } from 'next/navigation';

import { companyPage } from '@/lib/company-view.ts';
import { coverers, sectorsWithTerms, STATUSES } from '@/lib/companies.ts';
import { financials, type Basis } from '@/lib/financials.ts';
import { isRange, priceSeries, type Range } from '@/lib/prices.ts';
import { filings } from '@/lib/filings.ts';
import { newsFor } from '@/lib/engagement.ts';
import {
  AppHeader, Blank, Card, Chip, Empty, Fact, Facts, Seg, Tabs, crore, inr, type Tone,
} from '@/components/ui.tsx';
import { Statement } from '@/components/Statement.tsx';
import { PriceChart } from '@/components/PriceChart.tsx';
import { FilterList } from '@/components/FilterList.tsx';
import { DialogButton } from '@/components/DialogButton.tsx';

import { requireUser } from '../../../_lib/session.ts';
import {
  setCoverageAction, setSectorAction, setStatusAction,
} from '../../../_lib/actions/companies.ts';

/**
 * One company, everything held on it.
 *
 * The order is the order a person reads in: what it is, what it reported, who owns it, what it
 * filed, what was said about it, what is coming. Anything the system does not hold says so rather
 * than being omitted — a page that silently drops a section reads as a page with nothing to report.
 */

export const dynamic = 'force-dynamic';

/** The taxonomy's categories, in words a reader uses. */
const HOLDER_LABEL: Record<string, string> = {
  promoter: 'Promoter',
  mutual_fund: 'Mutual fund',
  fpi: 'FPI',
  insurance: 'Insurance',
  other: 'Other',
};

const STATUS_TONE: Record<string, Tone> = {
  holding: 'good', working: 'navy', watching: 'neutral', exited: 'warn', passed: 'neutral',
};

function ist(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  }).format(at);
}

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  // Both live in the URL, so a refresh lands where you were and a link to "PRAJIND consolidated,
  // yearly" is a link somebody can send.
  searchParams: Promise<{ basis?: string; pnl?: string; range?: string }>;
}) {
  const user = await requireUser();
  const { symbol } = await params;
  const co = await companyPage(symbol);
  if (!co) notFound();

  const sp = await searchParams;
  const wanted = sp.basis === 'standalone' || sp.basis === 'consolidated' ? (sp.basis as Basis) : undefined;

  const range: Range = isRange(sp.range) ? sp.range : '1y';

  const [recentFilings, news, fin, prices, desk, sectors] = await Promise.all([
    filings({ companyId: co.id, days: 180, limit: 25 }),
    newsFor(user.userId, { companyId: co.id, days: 90 }),
    financials(co.id, wanted),
    priceSeries(co.id, range),
    coverers(),
    sectorsWithTerms(),
  ]);

  // Whichever period kind the company actually files, defaulting to the longest it has — a year
  // says more about a business than a quarter, and an SME half-yearly filer has no quarters at all.
  const pnlTab = fin.pnl.find((p) => p.kind === sp.pnl) ?? fin.pnl[0];
  // One builder for every link on the page, so changing the range does not silently reset the
  // basis and a link carries the whole view rather than one third of it.
  const href = (next: { basis?: string; pnl?: string; range?: string }): string => {
    const q = new URLSearchParams();
    q.set('basis', next.basis ?? fin.basis);
    if (next.pnl ?? pnlTab?.kind) q.set('pnl', next.pnl ?? pnlTab!.kind);
    q.set('range', next.range ?? range);
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

        <Card
          title="Financials"
          action={
            // Both positions, always. This used to render plain text when a company filed only one
            // basis, on the argument that a switch with one live position teaches you it does
            // nothing — but the reader who goes looking for the switch and finds a word cannot
            // tell whether the control is missing or the data is, and goes looking further. The
            // unfiled side is shown disabled and says why on hover.
            <Seg
              small
              current={href({})}
              options={fin.bases.map((b) => ({
                href: href({ basis: b }),
                label: b === 'consolidated' ? 'Consolidated' : 'Standalone',
                disabled: !fin.filed.includes(b),
                why: `${co.symbol} has filed no ${b} results that this system holds.`,
              }))}
            />
          }
        >
          {fin.pnl.length === 0 ? (
            <Empty>
              No results have been parsed for this company yet. They arrive from the results feed
              once it has filed, and the whole history follows a backfill.
            </Empty>
          ) : (
            <>
              {fin.pnl.length > 1 && (
                <Tabs
                  current={href({})}
                  tabs={fin.pnl.map((p) => [href({ pnl: p.kind }), p.label])}
                />
              )}
              <Statement
                data={pnlTab!.statement}
                empty="Nothing reported for this period kind."
              />
            </>
          )}
        </Card>

        <Card title="Balance sheet">
          <Statement
            data={fin.balanceSheet}
            empty="No filing held for this company carries a balance sheet. Quarterly results do not; the annual one does."
          />
        </Card>

        <Card title="Cash flow">
          <Statement
            data={fin.cashFlow}
            empty="No filing held for this company carries a cash flow statement. It comes with the annual results."
          />
        </Card>

        <Card title="Ownership">
          {co.shareholding.length === 0 ? (
            <Empty>No shareholding pattern has been filed for this company since it was followed.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Quarter</th><th className="num">Promoter</th><th className="num">Pledged</th>
                    <th className="num">Encumbered</th><th className="num">FII</th><th className="num">DII</th>
                  </tr>
                </thead>
                <tbody>
                  {co.shareholding.map((s) => (
                    <tr key={s.asOf}>
                      <td className="num">{s.asOf}</td>
                      <td className="num">{s.promoterPct ? `${Number(s.promoterPct).toFixed(2)}%` : <Blank />}</td>
                      <td className="num">
                        {s.pledgePct !== null ? `${Number(s.pledgePct).toFixed(2)}%`
                          : <Blank why="Declared an encumbrance but did not break it down for the promoter line" />}
                      </td>
                      <td className="num">
                        {s.encumberedPct !== null ? `${Number(s.encumberedPct).toFixed(2)}%` : <Blank />}
                      </td>
                      <td className="num">{s.fiiPct ? `${Number(s.fiiPct).toFixed(2)}%` : <Blank />}</td>
                      <td className="num">{s.diiPct ? `${Number(s.diiPct).toFixed(2)}%` : <Blank />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">
            Pledge and encumbrance are percentages of the promoter holding, not of the company.
          </p>
        </Card>

        <Card
          title="Shareholders"
          action={
            co.holders.length > 0 ? (
              <span className="muted">everyone above 1%, as filed</span>
            ) : undefined
          }
        >
          {co.holders.length === 0 ? (
            <Empty>
              No shareholding pattern is held for this name yet. When one is, LODR requires it to
              name every holder above 1% and each promoter individually.
            </Empty>
          ) : (
            <div className="tbl-scroll scroll-box" tabIndex={0}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Holder</th><th>Category</th>
                    <th className="num">Shares</th><th className="num">Holding</th>
                  </tr>
                </thead>
                <tbody>
                  {co.holders.map((h) => (
                    <tr key={h.name}>
                      <td className="cell-wrap">{h.name}</td>
                      <td>
                        <Chip tone={h.category === 'promoter' ? 'navy' : 'neutral'}>
                          {HOLDER_LABEL[h.category] ?? h.category}
                        </Chip>
                      </td>
                      <td className="num">
                        {h.shares ? inr(h.shares, 0) : <Blank why="Not stated for this holder" />}
                      </td>
                      <td className="num">
                        {h.pct ? `${Number(h.pct).toFixed(2)}%` : <Blank why="Not stated for this holder" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Insider and pledge disclosures">
          {co.insider.length === 0 ? (
            <Empty>No PIT disclosures are held for this company.</Empty>
          ) : (
            <div className="tbl-scroll scroll-box" tabIndex={0}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Disclosed</th><th>Who</th><th>Category</th><th>What</th>
                    <th className="num">Shares</th><th className="num">Holding</th>
                  </tr>
                </thead>
                <tbody>
                  {co.insider.map((i) => (
                    <tr key={i.id}>
                      <td className="num">{ist(i.disclosedAt)}</td>
                      <td>{i.person}</td>
                      <td>{i.category ?? <Blank />}</td>
                      <td>{i.kind ?? <Blank />}</td>
                      <td className="num">{i.quantity ? inr(i.quantity, 0) : <Blank />}</td>
                      <td className="num">
                        {i.pctBefore !== null && i.pctAfter !== null
                          ? `${Number(i.pctBefore).toFixed(2)}% → ${Number(i.pctAfter).toFixed(2)}%`
                          : <Blank why="The disclosure did not report both sides" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Filings" action={<Link href={`/filings`}>All filings →</Link>}>
          {recentFilings.length === 0 ? (
            <Empty>Nothing filed in the last six months.</Empty>
          ) : (
            <FilterList placeholder="Filter filings…" label="Filter filings" show={5}>
            <ul className="item-plain scroll-box" tabIndex={0}>
              {recentFilings.map((f) => (
                <li
                  key={f.id}
                  // The haystack is chosen: the category and the summary, which is what somebody
                  // means when they type "auditor". The date is excluded — nobody filters a
                  // six-month list by typing a timestamp.
                  data-text={`${f.category ?? ''} ${f.summary ?? ''}`.toLowerCase()}
                >
                  <span className="num">{ist(f.announcedAt)}</span>
                  <b>{f.category ?? 'filing'}</b>
                  <span>{f.summary ?? ''}</span>
                  {f.attachmentUrl && (
                    <a href={f.attachmentUrl} target="_blank" rel="noreferrer">PDF</a>
                  )}
                </li>
              ))}
            </ul>
            </FilterList>
          )}
        </Card>

        <Card title="News" action={<Link href="/news">All news →</Link>}>
          {news.length === 0 ? (
            <Empty>
              No story has cleared the gate for this name in 90 days. Only matches with a stated
              mechanism appear anywhere in the app.
            </Empty>
          ) : (
            <FilterList placeholder="Filter news…" label="Filter news" show={3}>
            <ul className="news-list news-compact scroll-box" tabIndex={0}>
              {news.map((n) => (
                <li
                  key={n.id}
                  className="news-item"
                  data-text={`${n.title} ${n.source}`.toLowerCase()}
                >
                  <div className="news-main">
                    <p className="item-kind">
                      <span>{n.source}</span>
                      <span>{n.publishedAt ? ist(n.publishedAt) : 'undated'}</span>
                    </p>
                    <a className="news-title" href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
                    <p className="news-why">{n.mechanism}</p>
                  </div>
                </li>
              ))}
            </ul>
            </FilterList>
          )}
        </Card>

        <Card title="Calendar">
          {co.events.length === 0 ? (
            <Empty>Nothing scheduled, and nothing in the last month.</Empty>
          ) : (
            <ul className="desk-soon scroll-box" tabIndex={0}>
              {co.events.map((e) => (
                <li key={e.id}>
                  <span className="desk-soon-when">{e.onDate}</span>
                  <b>{e.kind === 'results' ? 'Results' : 'Board meeting'}</b>
                  <span className="desk-soon-detail">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
