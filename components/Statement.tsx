import { Blank, crore } from './ui.tsx';
import type { Statement as StatementData } from '@/lib/financials.ts';

/**
 * One financial statement: periods across, line items down.
 *
 * The layout every filing uses and the only one a trend can be read from — twelve rows of one
 * period each tells you what a company earned; one row of twelve periods tells you what happened
 * to it.
 *
 * The first column is sticky, because a table wide enough to be worth scrolling is a table where
 * you lose track of which line you are on.
 */

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2024-03-31` reads as `Mar 24`. Short, because it is a column header twelve times over. */
function periodLabel(end: string): string {
  const [y, m] = end.split('-');
  return `${MONTH[Number(m) - 1] ?? m} ${y?.slice(2) ?? ''}`;
}

export function Statement({
  data,
  /** EPS is per share and rupees; everything else is a figure in crore. */
  perShare = new Set(['eps_basic', 'eps_diluted']),
  empty,
}: {
  data: StatementData;
  perShare?: Set<string>;
  empty: string;
}) {
  if (data.periods.length === 0 || data.rows.length === 0) {
    return <p className="picker-none">{empty}</p>;
  }

  return (
    <div className="tbl-scroll">
      <table className="tbl stmt">
        <thead>
          <tr>
            <th className="stmt-item">In crore</th>
            {data.periods.map((p) => (
              <th key={p.end} className="num">
                {periodLabel(p.end)}
                {p.suspectDates && (
                  <span
                    className="stmt-flag"
                    title="The XBRL context declared this period's dates while carrying a different span of figures. The dates here come from the reported facts, not from the context."
                  >
                    ·
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.key} className={row.strong ? 'is-strong' : undefined}>
              <td className="stmt-item">
                {row.label}
                {row.derived && (
                  <span
                    className="stmt-flag"
                    title="Computed from the reported lines, not filed as its own figure: revenue less total expenses, with finance costs and depreciation added back."
                  >
                    computed
                  </span>
                )}
              </td>
              {row.values.map((v, i) => (
                <td key={data.periods[i]?.end ?? i} className="num">
                  {v === null ? (
                    <Blank why="Not reported in this filing" />
                  ) : perShare.has(row.key) ? (
                    Number(v).toFixed(2)
                  ) : (
                    crore(v)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
