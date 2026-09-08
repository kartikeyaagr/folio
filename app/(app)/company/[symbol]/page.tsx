import Link from 'next/link';
import { notFound } from 'next/navigation';

import { companyPage } from '@/lib/company-view.ts';
import { financials, type Basis } from '@/lib/financials.ts';
import { filings } from '@/lib/filings.ts';
import { newsFor } from '@/lib/engagement.ts';
import {
  AppHeader, Blank, Card, Chip, Empty, Fact, Facts, Seg, Tabs, crore, inr, type Tone,
} from '@/components/ui.tsx';
import { Statement } from '@/components/Statement.tsx';

import { requireUser } from '../../../_lib/session.ts';

/**
 * One company, everything held on it.
 *
 * The order is the order a person reads in: what it is, what it reported, who owns it, what it
 * filed, what was said about it, what is coming. Anything the system does not hold says so rather
 * than being omitted — a page that silently drops a section reads as a page with nothing to report.
 */

export const dynamic = 'force-dynamic';

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
  searchParams: Promise<{ basis?: string; pnl?: string }>;
}) {
  const user = await requireUser();
  const { symbol } = await params;
  const co = await companyPage(symbol);
  if (!co) notFound();

  const sp = await searchParams;
  const wanted = sp.basis === 'standalone' || sp.basis === 'consolidated' ? (sp.basis as Basis) : undefined;

  const [recentFilings, news, fin] = await Promise.all([
    filings({ companyId: co.id, days: 180, limit: 25 }),
    newsFor(user.userId, { companyId: co.id, days: 90 }),
    financials(co.id, wanted),
  ]);

  // Whichever period kind the company actually files, defaulting to the longest it has — a year
  // says more about a business than a quarter, and an SME half-yearly filer has no quarters at all.
  const pnlTab = fin.pnl.find((p) => p.kind === sp.pnl) ?? fin.pnl[0];
  const href = (next: { basis?: string; pnl?: string }): string => {
    const q = new URLSearchParams();
    q.set('basis', next.basis ?? fin.basis);
    if (next.pnl ?? pnlTab?.kind) q.set('pnl', next.pnl ?? pnlTab!.kind);
    return `?${q.toString()}`;
  };

  const latest = co.shareholding[0];
  const value =
    co.quantity && co.lastClose ? Number(co.quantity) * Number(co.lastClose) : null;

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
          <Fact label="Status" value={<Chip tone={STATUS_TONE[co.status] ?? 'neutral'}>{co.status}</Chip>} />
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

        <Card
          title="Financials"
          action={
            fin.bases.length > 1 ? (
              // Only offered when the company files both. A switch with one live position is a
              // control that teaches you it does nothing.
              <Seg
                small
                current={href({})}
                options={fin.bases.map((b) => ({
                  href: href({ basis: b }),
                  label: b === 'consolidated' ? 'Consolidated' : 'Standalone',
                }))}
              />
            ) : (
              <span className="muted">{fin.basis}</span>
            )
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

        <Card title="Insider and pledge disclosures">
          {co.insider.length === 0 ? (
            <Empty>No PIT disclosures are held for this company.</Empty>
          ) : (
            <div className="tbl-scroll">
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
            <ul className="item-plain">
              {recentFilings.map((f) => (
                <li key={f.id}>
                  <span className="num">{ist(f.announcedAt)}</span>
                  <b>{f.category ?? 'filing'}</b>
                  <span>{f.summary ?? ''}</span>
                  {f.attachmentUrl && (
                    <a href={f.attachmentUrl} target="_blank" rel="noreferrer">PDF</a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="News" action={<Link href="/news">All news →</Link>}>
          {news.length === 0 ? (
            <Empty>
              No story has cleared the gate for this name in 90 days. Only matches with a stated
              mechanism appear anywhere in the app.
            </Empty>
          ) : (
            <ul className="news-list">
              {news.map((n) => (
                <li key={n.id} className="news-item">
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
          )}
        </Card>

        <Card title="Calendar">
          {co.events.length === 0 ? (
            <Empty>Nothing scheduled, and nothing in the last month.</Empty>
          ) : (
            <ul className="desk-soon">
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
