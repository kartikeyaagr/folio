import Link from 'next/link';

import { filingCategories, filings } from '@/lib/filings.ts';
import { AppHeader, Blank, Card, Chip, Empty, Seg, type Tone } from '@/components/ui.tsx';

import { requireUser } from '../../_lib/session.ts';
import { dayMonthTime } from '@/components/ui';

/**
 * C1 — exchange filings, readable.
 *
 * The whole screen is a table because that is what this is: a chronological list with four facts
 * per row. State lives in the URL, so a filtered view is a link somebody can send.
 *
 * `linked_by` is shown rather than hidden. A filing matched to a company by symbol rather than by
 * ISIN is a weaker claim — that is the SME case, where NSE returns no ISIN at all — and a reader
 * deciding whether to trust a row should be able to see which it was.
 */

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'bad', high: 'bad', normal: 'navy', low: 'neutral',
};

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

/**
 * `?days=` is whatever is in the address bar, so it is not a number until this says so.
 *
 * Unvalidated, `days=abc` reached `filings()` as NaN and the heading as "NaN days", and
 * `days=99999` asked Postgres for the entire table under a heading that agreed it had. Anything
 * that is not a whole number of days from one to a year falls back to the default rather than
 * being half-honoured: a window that was silently corrected and one that was silently ignored
 * read identically on the page, and only one of them is what was asked for.
 *
 * The single returned value feeds the queries, the subtitle and the filter links below, so a link
 * followed from a bad URL lands on a good one.
 */
function windowDays(raw: string | undefined): number {
  const asked = Number(raw);
  if (!Number.isFinite(asked) || asked < 1) return DEFAULT_DAYS;
  return Math.min(Math.trunc(asked), MAX_DAYS);
}

export default async function FilingsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; days?: string; scope?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const days = windowDays(params.days);
  const all = params.scope === 'all';
  const category = params.category ?? null;

  const [rows, categories] = await Promise.all([
    filings({ all, category, days }),
    filingCategories(days),
  ]);

  const href = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { category: category ?? undefined, days: String(days), scope: params.scope, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const queryString = next.toString();
    return queryString ? `/filings?${queryString}` : '/filings';
  };

  return (
    <>
      <AppHeader
        title="Filings"
        subtitle={`${rows.length} in ${days} days${category ? ` · ${category}` : ''}${all ? ' · every listed company' : ' · followed names'}`}
      />

      <div className="page">
        <Card
          title="Announcements"
          action={
            <Seg
              current={all ? href({ scope: 'all' }) : href({ scope: undefined })}
              options={[
                { label: 'Ours', href: href({ scope: undefined }) },
                { label: 'Everything', href: href({ scope: 'all' }) },
              ]}
            />
          }
          padded={false}
        >
          <div className="filing-filters">
            <Link className={`chip-link${category === null ? ' is-on' : ''}`} href={href({ category: undefined })}>
              All categories
            </Link>
            {categories.slice(0, 12).map((c) => (
              <Link
                key={c.category}
                className={`chip-link${category === c.category ? ' is-on' : ''}`}
                href={href({ category: c.category })}
              >
                {c.category} <span>{c.n}</span>
              </Link>
            ))}
          </div>

          {rows.length === 0 ? (
            <Empty>
              No filings in this window. Announcements are fetched through the day.
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Company</th>
                    <th>Category</th>
                    <th>What it says</th>
                    <th>Matched by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id}>
                      <td className="num">{dayMonthTime(f.announcedAt)}</td>
                      <td>
                        {f.companyId ? (
                          <Link href={`/company/${f.symbol}`}>
                            <b>{f.symbol}</b>
                          </Link>
                        ) : (
                          <b>{f.symbol}</b>
                        )}
                        {f.name && <span className="cell-sub">{f.name}</span>}
                      </td>
                      <td>
                        {f.category ?? <Blank why="NSE published this filing with no category" />}
                        {f.alertSeverity && (
                          <Chip tone={SEVERITY_TONE[f.alertSeverity] ?? 'neutral'}>
                            {f.alertSeverity}
                          </Chip>
                        )}
                      </td>
                      <td className="cell-wrap">{f.summary ?? ''}</td>
                      <td>
                        {f.linkedBy === 'isin' ? (
                          'ISIN'
                        ) : f.linkedBy === 'symbol' ? (
                          <span title="NSE returned no ISIN for this filing, which is what it does for the whole SME board. The match is on the ticker alone.">
                            symbol
                          </span>
                        ) : (
                          <Blank why="This filing is not linked to a followed company" />
                        )}
                      </td>
                      <td>
                        {f.attachmentUrl && (
                          <a href={f.attachmentUrl} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
                            PDF
                          </a>
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
