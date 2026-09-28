import type { CompanyProgress, OverallProgress } from '@/lib/ingest/backfill-progress.ts';
import { BACKFILL_STEPS } from '@/lib/ingest/backfill.ts';

/**
 * Three layouts around one primitive. `/companies` gets the whole fleet's figure and, beside it, a
 * clause per name actually running; each row in its table gets a sliver of the same bar; a
 * company's own page gets the full block, with the steps already behind it named.
 */

const TOTAL_STEPS = BACKFILL_STEPS.length;

/** A native `<progress>` rather than a hand-built bar: the browser owns the fraction and the
 *  `progressbar` semantics, so there is no `role` or `aria-value*` to keep in step with `value`
 *  and `max` by hand. `aria-label` is still needed — the visible text beside it is not
 *  programmatically associated with the element. */
function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return <progress className="progress" value={value} max={max} aria-label={label} />;
}

/** The bar above `/companies`' table, shown only while the fleet owes something. */
export function BackfillSummary({
  overall,
  running,
}: {
  overall: OverallProgress;
  running: CompanyProgress[];
}) {
  if (overall.filled >= overall.owed && running.length === 0) return null;
  return (
    <div className="backfill-summary">
      <Bar
        value={overall.filled}
        max={overall.owed}
        label={`Backfill ${overall.filled} of ${overall.owed}`}
      />
      <span className="backfill-summary-text">
        Backfill {overall.filled} of {overall.owed}
        {running.length > 0 && (
          <>
            {' · '}
            {running
              .map((r) => `${r.symbol} step ${r.stepIndex} of ${TOTAL_STEPS}, ${r.stepLabel}`)
              .join(' · ')}
          </>
        )}
      </span>
    </div>
  );
}

/** The sliver beside a `/companies` row's status chip, for the one name that row is. */
export function BackfillRowBar({ progress }: { progress: CompanyProgress }) {
  const title =
    progress.subTotal !== null
      ? `${progress.stepLabel} — ${progress.subDone ?? 0} of ${progress.subTotal} trading days`
      : progress.stepLabel;
  return (
    <span className="backfill-row" title={title}>
      <Bar value={progress.stepIndex} max={TOTAL_STEPS} label={title} />
    </span>
  );
}

/** The block on a company's own page, shown only while its backfill is running. */
export function CompanyBackfillBlock({ progress }: { progress: CompanyProgress }) {
  return (
    <div className="backfill-block">
      <div className="backfill-block-head">
        <b>Filling in — attempt {progress.attempt}</b>
        <span>
          step {progress.stepIndex} of {TOTAL_STEPS}: {progress.stepLabel}
        </span>
      </div>
      <Bar
        value={progress.stepIndex}
        max={TOTAL_STEPS}
        label={`step ${progress.stepIndex} of ${TOTAL_STEPS}: ${progress.stepLabel}`}
      />
      {progress.subTotal !== null && (
        <div className="backfill-block-sub">
          {progress.stepLabel}: {progress.subDone ?? 0} of {progress.subTotal} trading days
        </div>
      )}
      {progress.outcomes.length > 0 && (
        <ul className="backfill-block-outcomes">
          {progress.outcomes.map((o) => (
            <li key={o.step}>
              {o.step}: {o.outcome}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
