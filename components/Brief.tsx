import Link from 'next/link';

import { Blank, Empty } from './ui.tsx';

/**
 * A brief, rendered as the document it is.
 *
 * Used in two places on purpose: the review queue, where somebody decides whether it is any good,
 * and the brief page, where somebody reads it. Reviewing a brief rendered as JSON fields is
 * reviewing a different artefact from the one that will be read — the generic field renderer would
 * show `by_company` as a line of `JSON.stringify`, which is not something a person can judge.
 *
 * Lora, because the design system reserves the serif for anything that is a document. A brief is a
 * written record, and it should not look like UI.
 */

export interface BriefContent {
  period?: unknown;
  by_company?: unknown;
  nothing_to_report?: unknown;
  coming_up?: unknown;
}

interface CompanySection {
  symbol: string;
  what_happened: string[];
  why_it_matters: string;
}

/**
 * The model's answer is validated against a schema on the way in, but a draft is stored as jsonb
 * and read back untyped, so the shape is checked here rather than trusted. A malformed section is
 * dropped rather than crashing the page a reviewer needs in order to reject it.
 */
function sections(value: unknown): CompanySection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): CompanySection[] => {
    if (typeof v !== 'object' || v === null) return [];
    const r = v as Record<string, unknown>;
    if (typeof r['symbol'] !== 'string') return [];
    return [{
      symbol: r['symbol'],
      what_happened: Array.isArray(r['what_happened'])
        ? r['what_happened'].filter((x): x is string => typeof x === 'string')
        : [],
      why_it_matters: typeof r['why_it_matters'] === 'string' ? r['why_it_matters'] : '',
    }];
  });
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

export function Brief({ content }: { content: BriefContent }) {
  const covered = sections(content.by_company);
  const quiet = strings(content.nothing_to_report);
  const coming = strings(content.coming_up);
  const period = typeof content.period === 'string' ? content.period : null;

  if (covered.length === 0 && quiet.length === 0 && coming.length === 0) {
    return <Empty>This brief has no content. That is worth rejecting rather than accepting.</Empty>;
  }

  return (
    <article className="brief prose">
      {period && <p className="brief-period">{period}</p>}

      {covered.map((s) => (
        <section key={s.symbol} className="brief-co">
          <h3>
            <Link href={`/company/${s.symbol}`}>{s.symbol}</Link>
          </h3>
          {s.what_happened.length === 0 ? (
            <p className="brief-none">
              <Blank why="This name was given a section with nothing in it" />
            </p>
          ) : (
            <ul>
              {s.what_happened.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {s.why_it_matters && <p className="brief-why">{s.why_it_matters}</p>}
        </section>
      ))}

      {/*
        Naming the quiet names is the point, not a footnote. A brief that lists only the names with
        something to say leaves a reader unable to tell "nothing happened" from "nobody looked".
      */}
      {quiet.length > 0 && (
        <section className="brief-quiet">
          <h3>Nothing to report</h3>
          <p>{quiet.join(' · ')}</p>
        </section>
      )}

      {coming.length > 0 && (
        <section className="brief-coming">
          <h3>Coming up</h3>
          <ul>
            {coming.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
