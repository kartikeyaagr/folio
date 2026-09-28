import Link from 'next/link';
import { notFound } from 'next/navigation';

import { brief, provenance } from '@/lib/briefs.ts';
import { label, shape } from '@/lib/agents/paths.ts';
import { Brief } from '@/components/Brief.tsx';
import { AppHeader, Card, Eyebrow } from '@/components/ui.tsx';

import { requireUser } from '../../../../_lib/session.ts';
import { weekdayTime } from '@/components/ui';

/**
 * One brief, kept.
 *
 * Shows what the agent originally wrote where a reviewer changed it before accepting. The diff is
 * recorded at acceptance for exactly this: a brief somebody corrected is evidence about the agent,
 * and it is the only evidence there is. Briefs since 28-Sep-2026 are published without review, so
 * they have no diff, and the subtitle says nobody read them first.
 */

export const dynamic = 'force-dynamic';

/** How many distinct things were corrected, as opposed to how many places. */
const fields = (edits: Record<string, unknown>): number =>
  new Set(Object.keys(edits).map(shape)).size;

export default async function OneBriefPage({ params }: { params: Promise<{ id: string }> }) {
  // Kept rather than discarded, for migration `0030`'s reason: the model and what the brief cost
  // are operating detail, and this page is the one an analyst reads to do their job.
  const user = await requireUser();
  const { id } = await params;
  const b = await brief(id);
  if (!b) notFound();

  return (
    <>
      <AppHeader
        title="Brief"
        subtitle={provenance(b, weekdayTime(b.writtenAt))}
        back="/news/brief"
        backTitle="Briefs"
      />

      <div className="page">
        <Card
          title={b.title}
          action={
            user.isAdmin ? (
              <span className="draft-meta">
                {b.model ?? 'model not recorded'}
                {b.costUsd ? ` · $${Number(b.costUsd).toFixed(4)}` : ''}
              </span>
            ) : undefined
          }
        >
          <Brief content={b.content} />
        </Card>

        {b.edits && Object.keys(b.edits).length > 0 && (
          <Card title="Changed before it was accepted">
            {/*
              Counted by field, listed by position. Six corrections to `by_company[].why_it_matters`
              are one thing this agent keeps getting wrong and six places it got it wrong, and the
              two numbers answer different questions.
            */}
            <Eyebrow>
              {fields(b.edits)} {fields(b.edits) === 1 ? 'field' : 'fields'} ·{' '}
              {Object.keys(b.edits).length} corrected
            </Eyebrow>
            <ul className="draft-sources">
              {Object.keys(b.edits).sort().map((path) => (
                <li key={path}>{label(path, b.content)}</li>
              ))}
            </ul>
            <p className="hint">
              Corrections are the evidence of where this agent is weak.{' '}
              <Link href="/agents">The registry</Link> counts the runs; this says what was wrong
              with them.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
