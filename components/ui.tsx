import Link from 'next/link';
import type { ReactNode } from 'react';

import { searchCompanies } from '@/app/_lib/actions/search.ts';
import { MONTHS } from '@/lib/months.ts';

import { CompanySearch } from './CompanySearch.tsx';

/**
 * The shared vocabulary.
 *
 * Everything visual in the app should come from here or from a class in `globals.css`. Styling is
 * by class rather than inline `style` objects, because inline styles cannot express :hover,
 * :focus-visible, :active or :disabled — and a control with no hover state is the fastest way to
 * make software feel unfinished.
 */

/* --------------------------------------------------------------------------------------------- */
/* Page header                                                                                     */
/* --------------------------------------------------------------------------------------------- */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Wed 3 Sep 2026", in the fund's own time zone regardless of where the server sits. */
export function todayLabel(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = DAYS.findIndex((d) => get('weekday').startsWith(d));
  return `${dow >= 0 ? DAYS[dow] : get('weekday')} ${Number(get('day'))} ${MONTHS[Number(get('month')) - 1]} ${get('year')}`;
}

/**
 * Dates, in the fund's time zone and in one vocabulary.
 *
 * Every one of these reads its parts from `Intl` and then spells the month from `MONTHS`,
 * rather than letting `Intl` name it. That is not decoration: **en-GB renders September as
 * "Sept"** — four letters where the other eleven months are three — which makes a column of dates
 * ragged and is why `todayLabel` was written this way in the first place.
 *
 * Nine copies of this lived on the pages until 18-Sep-2026, and they had drifted: five formatted
 * in en-GB, three in en-IN and one in en-CA, so the same instant read `09:30` on the filings
 * screen and `9:30 am` on the document one. A date is chrome, and `.interface-design/system.md`
 * puts chrome here.
 */
interface IstParts {
  weekday: string;
  /** Zero-padded, so a column of days lines up. */
  day: string;
  /** "Sep", never "Sept". */
  mon: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
}

function istParts(at: Date): IstParts {
  const got: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)) {
    got[part.type] = part.value;
  }
  const month = got['month'] ?? '';
  return {
    weekday: got['weekday'] ?? '',
    day: got['day'] ?? '',
    mon: MONTHS[Number(month) - 1] ?? '',
    month,
    year: got['year'] ?? '',
    hour: got['hour'] ?? '',
    minute: got['minute'] ?? '',
  };
}

/** "3 Sep" — a day, where the year is obvious from context. */
export function dayMonth(at: Date): string {
  const p = istParts(at);
  return `${Number(p.day)} ${p.mon}`;
}

/** "3 Sep 2026" — a day that happened, where a time would claim a precision it has not got. */
export function dayMonthYear(at: Date): string {
  const p = istParts(at);
  return `${Number(p.day)} ${p.mon} ${p.year}`;
}

/** "08 Sep, 09:30" — a day and a time, in a column where the days line up. */
export function dayMonthTime(at: Date): string {
  const p = istParts(at);
  return `${p.day} ${p.mon}, ${p.hour}:${p.minute}`;
}

/** "Thu 3 Sep, 09:30" — for a list read down, where the weekday is the thing you scan. */
export function weekdayTime(at: Date): string {
  const p = istParts(at);
  return `${p.weekday} ${Number(p.day)} ${p.mon}, ${p.hour}:${p.minute}`;
}

/** "3 Sep 2026, 09:30" — a full timestamp. Em dash for nothing, which is what these sites showed. */
export function stamp(at: Date | null): string {
  if (at === null) return '—';
  const p = istParts(at);
  return `${Number(p.day)} ${p.mon} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "2026-09-08" — not a label. The value a date input opens on, in the fund's day. */
export function istDate(at = new Date()): string {
  const p = istParts(at);
  return `${p.year}-${p.month.padStart(2, '0')}-${p.day}`;
}

/**
 * The strip at the top of every page: what this is, one line of context, the ⌘K search, the date.
 *
 * A page states its name and shows its content. The subtitle is one line of figures — never a
 * paragraph explaining the screen; if a screen needs one, the screen is wrong.
 */
export function AppHeader({
  title,
  subtitle,
  back,
  backTitle = 'Back',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: string;
  backTitle?: string;
}) {
  return (
    <header className="app-head">
      {back && (
        <Link href={back} className="app-back" title={backTitle} aria-label={backTitle}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m12 19-7-7 7-7M19 12H5" />
          </svg>
        </Link>
      )}
      {/* A node, not a string: `/doc/[id]` hands this an editable title. Everything else hands it
          the words, and gets the same heading it always had. */}
      {typeof title === 'string' ? <h1 className="app-title">{title}</h1> : title}
      <span className="app-sub">{subtitle}</span>
      <CompanySearch search={searchCompanies} />
      <span className="app-date">{todayLabel()}</span>
    </header>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Primitives                                                                                      */
/* --------------------------------------------------------------------------------------------- */

type ButtonTone = 'default' | 'primary' | 'quiet' | 'danger' | 'link';

export const btnClass = (tone: ButtonTone = 'default', small?: boolean, extra?: string) =>
  ['btn', tone !== 'default' && `btn-${tone}`, small && 'btn-sm', extra].filter(Boolean).join(' ');

export function Button({
  children,
  tone = 'default',
  small,
  className,
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  small?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  return (
    <button {...rest} className={btnClass(tone, small, className)}>
      {children}
    </button>
  );
}

/** A link that looks like a button. `<a>` when it navigates, `<button>` when it acts — never a div. */
export function LinkButton({
  children,
  tone = 'default',
  small,
  className,
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  small?: boolean;
  className?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className'>) {
  return (
    <a {...rest} className={btnClass(tone, small, className)}>
      {children}
    </a>
  );
}

export function Card({
  title,
  action,
  children,
  padded = true,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {title !== undefined && (
        <header className="card-head">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

/** A small uppercase label that titles a section inside a card or pane. */
export function Eyebrow({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="box-head">
      <h3 className="eyebrow">{children}</h3>
      {right}
    </div>
  );
}

export type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'navy';

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** A segmented control of links, the value in the URL. */
export function Seg({
  options,
  current,
  small,
}: {
  options: readonly {
    href: string;
    label: ReactNode;
    count?: number | string;
    /** Offered but not available. Rendered in place, with `why` as its title. */
    disabled?: boolean;
    why?: string;
  }[];
  current: string;
  small?: boolean;
}) {
  return (
    <div className={small ? 'seg seg-sm' : 'seg'}>
      {options.map((o) =>
        // A position that exists and cannot be taken, rather than one that is not drawn. Hiding it
        // makes a reader wonder whether the control is missing or the data is, which is the thing
        // they then go looking for.
        o.disabled ? (
          <span key={o.href} aria-disabled="true" title={o.why}>
            {o.label}
          </span>
        ) : (
          <a key={o.href} href={o.href} aria-current={o.href === current ? 'true' : undefined}>
            {o.label}
            {o.count !== undefined && <span className="seg-n">{o.count}</span>}
          </a>
        ),
      )}
    </div>
  );
}

/**
 * The signature: a value the system declines to supply, with the reason next to it.
 *
 * This exists because the three ways of rendering "we don't know" are all worse. An empty cell
 * reads as broken. A zero reads as a measured fact and is the most dangerous of the three. A dash
 * alone reads as "not applicable" when the truth is usually "no source answers this". The hatch
 * says *deliberately blank*, and `why` says by whom and on what grounds.
 */
export function Blank({ why }: { why?: string }) {
  return (
    <>
      <span
        className="blank"
        role="img"
        aria-label={why ? `Not answered: ${why}` : 'Not answered'}
      />
      {why && <span className="blank-why">{why}</span>}
    </>
  );
}

const TONE_COLOUR: Record<Tone, string | undefined> = {
  neutral: undefined,
  good: 'var(--teal)',
  bad: 'var(--red)',
  warn: 'var(--amber)',
  navy: 'var(--navy)',
};

/** A headline figure on its own card. `sub` is the one line of context under it. */
export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  // `| undefined` explicitly: exactOptionalPropertyTypes is on, and every call site computes the
  // tone from a condition, so passing undefined is the normal case rather than an omission.
  tone?: Tone | undefined;
}) {
  const colour = tone ? TONE_COLOUR[tone] : undefined;
  return (
    <div className="stat">
      <span className="stat-l">{label}</span>
      <span className="stat-v" style={colour ? { color: colour } : undefined}>
        {value}
      </span>
      {sub !== undefined && <span className="stat-s">{sub}</span>}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}

/** A small tinted tile inside a pane: three or four of them summarise the thing on screen. */
export function Fact({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone | undefined;
}) {
  const colour = tone ? TONE_COLOUR[tone] : undefined;
  return (
    <div className="fact">
      <div className="fact-k">{label}</div>
      <div className="fact-v" style={colour ? { color: colour } : undefined}>
        {value}
      </div>
      {sub !== undefined && <div className="fact-s">{sub}</div>}
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <div className="facts">{children}</div>;
}

/** URL-driven, so pages stay server components and every tab is linkable and survives a refresh. */
export function Tabs({
  tabs,
  current,
  bar,
}: {
  /** `[href, label]`, or `[href, label, why]` for a tab that exists and has nothing behind it. */
  tabs: readonly (readonly [string, ReactNode] | readonly [string, ReactNode, string])[];
  current: string;
  bar?: boolean;
}) {
  return (
    <nav className={bar ? 'tabs tabs-bar' : 'tabs'}>
      {tabs.map(([href, label, why]) =>
        // Same reasoning as `Seg`: a tab that is not drawn leaves a reader unable to tell whether
        // the view is missing or the data is, and the page stops looking the same from one company
        // to the next.
        why ? (
          <span key={href} aria-disabled="true" title={why}>
            {label}
          </span>
        ) : (
          <a key={href} href={href} aria-current={href === current ? 'page' : undefined}>
            {label}
          </a>
        ),
      )}
    </nav>
  );
}

/* --------------------------------------------------------------------------------------------- */
/* Tables and formatting                                                                           */
/* --------------------------------------------------------------------------------------------- */

/* The `table`/`th`/`td`/`num` style objects lived here through the v2 rebuild so half-migrated
   pages would not look like two products. Every page now uses `.tbl`, so they are gone: an
   inline-style table cannot express a hover or a sticky head, and leaving the objects exported is
   how a second way of drawing a table starts again. */

/** Indian digit grouping — 12,34,567.89, not 1,234,567.89. */
export function inr(value: string | number | null, dp = 2): string {
  if (value === null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** ₹ in crore, two places: the unit a fund thinks in. */
export function crore(value: string | number | null, dp = 2): string {
  if (value === null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `₹${(n / 1e7).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })} cr`;
}

/** "+1.8%" / "−0.6%" with the sign always shown; the tone the caller wants comes from the sign. */
export function signedPct(value: number | string | null, dp = 1): string {
  if (value === null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(dp)}%`;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="pane-empty">{children}</p>;
}
