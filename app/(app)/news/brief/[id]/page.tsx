import Link from 'next/link';
import { notFound } from 'next/navigation';

import { brief } from '@/lib/briefs.ts';
import { Brief } from '@/components/Brief.tsx';
import { AppHeader, Card, Eyebrow } from '@/components/ui.tsx';

import { requireUser } from '../../../../_lib/session.ts';

/**
 * One brief, kept.
 *
 * Shows what the agent originally wrote where a reviewer changed it before accepting. The diff is
 * recorded at acceptance for exactly this: a brief somebody corrected is evidence about the agent,
 * and it is the only evidence there is.
 */

export const dynamic = 'force-dynamic';

function ist(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}

export default async function OneBriefPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const b = await brief(id);
  if (!b) notFound();

  return (
    <>
      <AppHeader
        title="Brief"
        subtitle={`${ist(b.writtenAt)} · accepted by ${b.acceptedBy ?? 'somebody'}`}
        back="/news/brief"
        backTitle="Briefs"
      />

      <div className="page">
        <Card
          title={b.title}
          action={
            <span className="draft-meta">
              {b.model ?? 'model not recorded'}
              {b.costUsd ? ` · $${Number(b.costUsd).toFixed(4)}` : ''}
            </span>
          }
        >
          <Brief content={b.content} />
        </Card>

        {b.edits && b.edits.length > 0 && (
          <Card title="Changed before it was accepted">
            <Eyebrow>{b.edits.length} {b.edits.length === 1 ? 'field' : 'fields'}</Eyebrow>
            <ul className="draft-sources">
              {b.edits.map((e, i) => (
                <li key={i}>{e.field}</li>
              ))}
            </ul>
            <p className="hint">
              A brief somebody corrected is the only evidence there is about where this agent is
              weak. <Link href="/agents">The registry</Link> counts the runs; this says what was
              wrong with them.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
