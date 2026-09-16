import Link from 'next/link';

import { allDocuments, INGESTED, KIND_LABEL } from '@/lib/workspace.ts';
import { AppHeader, Blank, Card, Chip, Empty, Seg } from '@/components/ui.tsx';
import { DeleteDocument } from '@/components/DeleteDocument.tsx';

import { requireUser } from '../../_lib/session.ts';
import { archiveDocumentAction } from '../../_lib/actions/workspace.ts';

/**
 * Everything written or ingested, in one list.
 *
 * A company page shows that company's documents, which is the right default and leaves a hole:
 * agent 4's news brief is about the whole book, so it carries no company and appeared on no page
 * at all — written, versioned, attributed, and reachable from nowhere. Anything this system can
 * create has to be findable.
 *
 * Which is also why archive and delete are offered here and not only on a company page. This list
 * showed an Archived tab while carrying nothing that could archive or restore anything, and for a
 * document belonging to no company it is the only screen there is: a news brief could be written
 * and then never put away by anybody.
 */

export const dynamic = 'force-dynamic';

const when = (d: Date | null): string =>
  d === null
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(d);

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
                    <th className="num">Versions</th><th>Last saved</th><th>By</th><th />
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
                      <td className="num">{when(d.updatedAt)}</td>
                      <td>{d.updatedByName ?? <Blank why="Written before saves were attributed" />}</td>
                      <td className="cell-note">
                        <div className="form-actions">
                          <form action={archiveDocumentAction}>
                            <input type="hidden" name="id" value={d.id} />
                            {d.archivedAt && <input type="hidden" name="restore" value="1" />}
                            <button type="submit" className="btn btn-link">
                              {d.archivedAt ? 'Restore' : 'Archive'}
                            </button>
                          </form>
                          {/* No symbol passed on purpose — a document with no company has no company
                              page to land on, so this action falls back to this list. */}
                          <DeleteDocument id={d.id} title={d.title} versions={d.versions} symbol={d.symbol} />
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
