import Link from 'next/link';

import { allDocuments, INGESTED, KIND_LABEL } from '@/lib/workspace.ts';
import { AppHeader, Blank, Card, Chip, Empty, Seg } from '@/components/ui.tsx';

import { requireUser } from '../../_lib/session.ts';
import { stamp } from '@/components/ui';

/**
 * Everything written or ingested, in one list.
 *
 * A company page shows that company's documents, which is the right default and leaves a hole:
 * agent 4's news brief is about the whole book, so it carries no company and appeared on no page
 * at all — written, versioned, attributed, and reachable from nowhere. Anything this system can
 * create has to be findable.
 */

export const dynamic = 'force-dynamic';

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  await requireUser();
  const showArchived = (await searchParams).archived === '1';
  const docs = await allDocuments({ archived: showArchived });

  return (
    <>
      <AppHeader
        title="Documents"
        subtitle={`${docs.length} ${docs.length === 1 ? 'document' : 'documents'}`}
        back="/companies"
        backTitle="Companies"
      />

      <div className="page">
        <Card
          title="Everything held"
          action={
            <Seg
              small
              current={showArchived ? '/documents?archived=1' : '/documents'}
              options={[
                { label: 'Current', href: '/documents' },
                { label: 'Archived', href: '/documents?archived=1' },
              ]}
            />
          }
          padded={docs.length === 0}
        >
          {docs.length === 0 ? (
            <Empty>
              {showArchived
                ? 'Nothing archived.'
                : 'Nothing written yet. Notes, memos and models are made on a company page; transcripts arrive with the filings.'}
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Title</th><th>Company</th><th>Kind</th>
                    <th className="num">Versions</th><th>Last saved</th><th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} className={d.archivedAt ? 'pf-void' : undefined}>
                      <td className="cell-wrap">
                        <Link href={`/doc/${d.id}`}><b>{d.title}</b></Link>
                      </td>
                      <td>
                        {d.symbol ? (
                          <Link href={`/company/${d.symbol}`}>{d.symbol}</Link>
                        ) : (
                          // Not a gap: a brief covering the whole book belongs to no one name, and
                          // this list is where it is reachable at all.
                          <Blank why="About the book rather than one company" />
                        )}
                      </td>
                      <td>
                        {INGESTED.has(d.kind) ? (
                          <Chip tone="neutral">{KIND_LABEL[d.kind] ?? d.kind}</Chip>
                        ) : (
                          (KIND_LABEL[d.kind] ?? d.kind)
                        )}
                      </td>
                      <td className="num">{d.versions}</td>
                      <td className="num">{stamp(d.updatedAt)}</td>
                      <td>{d.updatedByName ?? <Blank why="Written before saves were attributed" />}</td>
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
