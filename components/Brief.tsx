import Link from 'next/link';

import { label } from '@/lib/agents/paths.ts';

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
  /**
   * Where this section sits in `by_company`, which is **not** where it sits in this array.
   *
   * `sections()` drops a malformed element, and `what_happened` drops a non-string line — so the
   * rendered order and the stored order part company exactly when a draft is malformed, which is
   * the case a reviewer is here to catch. A form field named from the rendered position would then
   * carry a correction typed against one company into a different company's judgement, with no
   * error and no symptom. Every `name=` below is built from these.
   */
  index: number;
  symbol: string;
  what_happened: { index: number; line: string }[];
  why_it_matters: string;
}

/**
 * The model's answer is validated against a schema on the way in, but a draft is stored as jsonb
 * and read back untyped, so the shape is checked here rather than trusted. A malformed section is
 * dropped rather than crashing the page a reviewer needs in order to reject it.
 */
function sections(value: unknown): CompanySection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v, index): CompanySection[] => {
    if (typeof v !== 'object' || v === null) return [];
    const r = v as Record<string, unknown>;
    if (typeof r['symbol'] !== 'string') return [];
    return [{
      index,
      symbol: r['symbol'],
      what_happened: lines(r['what_happened']),
      why_it_matters: typeof r['why_it_matters'] === 'string' ? r['why_it_matters'] : '',
    }];
  });
}

/** The string elements of a list, each still knowing where it was. */
function lines(value: unknown): { index: number; line: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v, index) => (typeof v === 'string' ? [{ index, line: v }] : []));
}

const strings = (value: unknown): { index: number; line: string }[] => lines(value);

/**
 * A line of the brief that a reviewer may correct in place.
 *
 * A textarea that inherits `.brief.prose` — Lora, 15.5/1.65 — rather than `.draft-edit`'s 14/1.55,
 * with its border appearing on hover and focus. The docstring above is the reason: reviewing a
 * brief rendered as form controls is reviewing a different artefact from the one that will be
 * read, and a control that changes the typography changes the artefact as surely as one that
 * changes the words.
 */
function Line({ path, value, rows = 1 }: { path: string; value: string; rows?: number }) {
  return (
    <textarea
      className="brief-edit"
      name={`f.${path}`}
      defaultValue={value}
      rows={Math.min(10, Math.max(rows, Math.ceil(value.length / 64)))}
      // The company is in the heading immediately above, so the path alone is enough here.
      aria-label={`${label(path)} — correct before accepting`}
    />
  );
}

/** Drop this line from the brief. Rarer than correcting one, and quieter on the page. */
function Drop({ path }: { path: string }) {
  return (
    <label className="brief-drop">
      <input type="checkbox" name={`d.${path}`} value="1" />
      <span>drop</span>
    </label>
  );
}

export function Brief({ content, editing = false }: { content: BriefContent; editing?: boolean }) {
  const covered = sections(content.by_company);
  const quiet = strings(content.nothing_to_report);
  const coming = strings(content.coming_up);
  const period = typeof content.period === 'string' ? content.period : null;

  if (covered.length === 0 && quiet.length === 0 && coming.length === 0) {
    return <Empty>This brief has no content.</Empty>;
  }

  return (
    <article className={editing ? 'brief prose brief-editing' : 'brief prose'}>
      {period !== null &&
        (editing ? (
          <p className="brief-period">
            <Line path="period" value={period} />
          </p>
        ) : (
          <p className="brief-period">{period}</p>
        ))}

      {covered.map((s) => (
        <section key={s.index} className="brief-co">
          <h3>
            {/*
              Plain text while editing. `/review` is a server component and the design system's
              list of client components is closed, so there is no unsaved-changes guard — and this
              heading sits inside the accept form beside every box a reviewer has just filled. One
              mis-aimed tap would discard the lot. The company link is in the card header already.
            */}
            {editing ? s.symbol : <Link href={`/company/${s.symbol}`}>{s.symbol}</Link>}
            {editing && <Drop path={`by_company[${s.index}]`} />}
          </h3>
          {s.what_happened.length === 0 ? (
            <p className="brief-none">
              <Blank why="This section was left empty" />
            </p>
          ) : (
            <ul>
              {s.what_happened.map((w) => (
                <li key={w.index}>
                  {editing ? (
                    <>
                      <Line path={`by_company[${s.index}].what_happened[${w.index}]`} value={w.line} />
                      <Drop path={`by_company[${s.index}].what_happened[${w.index}]`} />
                    </>
                  ) : (
                    w.line
                  )}
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            <p className="brief-why">
              <Line path={`by_company[${s.index}].why_it_matters`} value={s.why_it_matters} rows={2} />
            </p>
          ) : (
            s.why_it_matters && <p className="brief-why">{s.why_it_matters}</p>
          )}
        </section>
      ))}

      {/*
        Naming the quiet names is the point, not a footnote. A brief that lists only the names with
        something to say leaves a reader unable to tell "nothing happened" from "nobody looked".
      */}
      {quiet.length > 0 && (
        <section className="brief-quiet">
          <h3>Nothing to report</h3>
          {editing ? (
            // Symbols, not prose. Retyping one is not a correction; saying this name was not
            // actually quiet is, so they can be dropped and not edited.
            <ul className="brief-symbols">
              {quiet.map((q) => (
                <li key={q.index}>
                  {q.line}
                  <Drop path={`nothing_to_report[${q.index}]`} />
                </li>
              ))}
            </ul>
          ) : (
            <p>{quiet.map((q) => q.line).join(' · ')}</p>
          )}
        </section>
      )}

      {coming.length > 0 && (
        <section className="brief-coming">
          <h3>Coming up</h3>
          <ul>
            {coming.map((c) => (
              <li key={c.index}>
                {editing ? (
                  <>
                    <Line path={`coming_up[${c.index}]`} value={c.line} />
                    <Drop path={`coming_up[${c.index}]`} />
                  </>
                ) : (
                  c.line
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
