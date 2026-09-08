/**
 * Parse the XBRL instance documents NSE publishes for financial results.
 *
 * Ported from v2's `services/ingest/src/trisula_ingest/xbrl.py`. The XML handling is new; the
 * judgement below is not, and is the reason this file exists.
 *
 * The trap
 * --------
 * A results document reports the quarter and the year to date side by side, in two contexts. The
 * context elements are supposed to say which period each covers. They lie. The year-to-date
 * context declares the *quarter's* start and end dates while the facts inside it report nine
 * months of revenue. Reading `xbrli:period` — the textbook-correct thing — silently reports
 * year-to-date revenue as a quarter. Verified again on VSTTILLERS Q3 FY25: ₹693.1 crore reported
 * under a context claiming Oct-Dec, against a true quarter of ₹219.1 crore. Threefold, no error.
 *
 * So the period comes from the reported *facts*, and the context's own dates are kept only to
 * flag the disagreement. Where a document reports no period as a fact, the context is used and
 * the row is marked inferred rather than quietly trusted.
 *
 * Why not a validating XBRL library: these instances are flat — a handful of contexts, one
 * namespace, forty-odd stable element names. The difficulty is in the data, not the XML.
 */

import { XMLParser } from 'fast-xml-parser';

const XBRLI = 'http://www.xbrl.org/2003/instance';
/** The taxonomy namespace is BSE's, used by both exchanges. Matched by suffix, never pinned. */
const FIN_NS = /\/in-bse-fin$/;

export class UnparseableXbrl extends Error {}

export type PeriodKind = 'quarter' | 'half_year' | 'year_to_date' | 'year';

export interface Period {
  start: string;
  end: string;
  kind: PeriodKind;
  months: number;
}

export interface Report {
  basis: 'standalone' | 'consolidated';
  period: Period;
  audited: boolean | null;
  facts: Record<string, string>;
  /** The period came from the context, not from reported facts — the weaker source. */
  periodInferred: boolean;
  /** The context's declared dates disagree with the facts inside it. The norm for year-to-date. */
  contextDatesDisagree: boolean;
  /** Balance sheet as at this period's end. Empty for an ordinary quarterly filing. */
  instantFacts: Record<string, string>;
}

export interface Instance {
  symbol: string | null;
  isin: string | null;
  companyName: string | null;
  reports: Report[];
}

interface Node {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: Node[];
}

const localName = (tag: string): string => tag.slice(tag.indexOf(':') + 1);
const prefixOf = (tag: string): string => (tag.includes(':') ? tag.slice(0, tag.indexOf(':')) : '');

/** Months inclusive of both ends, matching the Python. */
function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  return (ey - sy) * 12 + em - sm + 1;
}

/**
 * Name the period by its length. Six months is either a half year or the year-to-date at Q2, and
 * for a half-yearly filer those are genuinely the same number.
 */
function classify(start: string, end: string): PeriodKind {
  const months = monthsBetween(start, end);
  if (months <= 3) return 'quarter';
  if (months <= 6) return 'half_year';
  if (months >= 12) return 'year';
  return 'year_to_date';
}

/** ISO date or null. Anything else is not a date we will act on. */
function asDate(value: string | undefined): string | null {
  if (!value) return null;
  const t = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** fast-xml-parser's object form loses order and repeats; walk it into a plain tree instead. */
function toTree(name: string, raw: unknown): Node {
  const node: Node = { name, attrs: {}, text: '', children: [] };
  if (raw === null || raw === undefined) return node;
  if (typeof raw !== 'object') {
    node.text = String(raw);
    return node;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '#text') {
      node.text = value === null || value === undefined ? '' : String(value);
    } else if (key.startsWith('@_')) {
      node.attrs[key.slice(2)] = String(value);
    } else if (Array.isArray(value)) {
      for (const item of value) node.children.push(toTree(key, item));
    } else {
      node.children.push(toTree(key, value));
    }
  }
  return node;
}

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function parse(content: Buffer | string): Instance {
  // fast-xml-parser does not resolve external entities, so there is no XXE surface to defuse.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(content.toString()) as Record<string, unknown>;
  } catch (err) {
    throw new UnparseableXbrl(`not well-formed XML: ${String(err)}`);
  }

  const rootName = Object.keys(doc).find((k) => !k.startsWith('?'));
  if (!rootName) throw new UnparseableXbrl('no root element');
  const root = toTree(rootName, doc[rootName]);

  // Resolve which prefixes mean what, from the root's namespace declarations.
  let xbrliPrefix = 'xbrli';
  const finPrefixes = new Set<string>();
  for (const [attr, uri] of Object.entries(root.attrs)) {
    if (!attr.startsWith('xmlns')) continue;
    const prefix = attr === 'xmlns' ? '' : attr.slice(6);
    if (uri === XBRLI) xbrliPrefix = prefix;
    if (FIN_NS.test(uri)) finPrefixes.add(prefix);
  }
  if (finPrefixes.size === 0) {
    throw new UnparseableXbrl('no in-bse-fin namespace; not a results instance');
  }

  const isContext = (n: Node) => prefixOf(n.name) === xbrliPrefix && localName(n.name) === 'context';
  const isFin = (n: Node) => finPrefixes.has(prefixOf(n.name));

  // ---- contexts, and the dates they claim -------------------------------------------------
  const declared = new Map<string, { start: string | null; end: string | null }>();
  const dimensioned = new Set<string>();
  for (const ctx of walk(root)) {
    if (!isContext(ctx)) continue;
    const cid = ctx.attrs['id'];
    if (!cid) continue;
    let start: string | null = null;
    let end: string | null = null;
    for (const n of walk(ctx)) {
      const name = localName(n.name);
      if (name === 'startDate') start = asDate(n.text);
      else if (name === 'endDate' || name === 'instant') end = asDate(n.text);
      else if (name === 'explicitMember') {
        // A dimensioned context is a breakdown, not a reporting period. Including one would
        // double-count the components of a line against the line itself.
        dimensioned.add(cid);
      }
    }
    declared.set(cid, { start, end });
  }

  // ---- facts, grouped by the context they belong to ----------------------------------------
  const byContext = new Map<string, Record<string, string>>();
  for (const n of walk(root)) {
    if (!isFin(n)) continue;
    const cid = n.attrs['contextRef'];
    if (!cid || dimensioned.has(cid)) continue;
    const text = n.text.trim();
    if (!text) continue;
    let facts = byContext.get(cid);
    if (!facts) byContext.set(cid, (facts = {}));
    facts[localName(n.name)] = text;
  }
  if (byContext.size === 0) {
    throw new UnparseableXbrl('no financial facts found; not a results instance');
  }

  const first = (key: string): string | null => {
    for (const facts of byContext.values()) if (key in facts) return facts[key] ?? null;
    return null;
  };

  // Balance-sheet figures live in instant contexts, keyed by the date they are "as at".
  const instants = new Map<string, Record<string, string>>();
  for (const [cid, facts] of byContext) {
    const d = declared.get(cid);
    if (d && d.start === null && d.end !== null) {
      Object.assign((instants.get(d.end) ?? instants.set(d.end, {}).get(d.end))!, facts);
    }
  }

  const reports: Report[] = [];
  for (const [cid, facts] of byContext) {
    // The period the *facts* report, which is the one to believe.
    let start = asDate(facts['DateOfStartOfReportingPeriod']);
    let end = asDate(facts['DateOfEndOfReportingPeriod']);
    let inferred = false;

    const ctx = declared.get(cid) ?? { start: null, end: null };
    if (start === null || end === null) {
      start = ctx.start;
      end = ctx.end;
      inferred = true;
    }
    if (start === null || end === null) continue;

    const disagree = !inferred && (start !== ctx.start || end !== ctx.end);

    let basis = (facts['NatureOfReportStandaloneConsolidated'] ?? '').trim().toLowerCase();
    if (basis !== 'standalone' && basis !== 'consolidated') {
      // An instant context is a position as at a date, not a reporting period. Its figures were
      // collected above; skip it rather than store a period with no basis and no P&L.
      //
      // `ProfitLossForThePeriod` — with "The" — is the Non-Ind-AS spelling, which the whole SME
      // board files under. Without it a Non-Ind-AS report that happened to omit revenue would be
      // dropped here on the grounds of having no P&L, while carrying a full one.
      if (
        !('RevenueFromOperations' in facts) &&
        !('ProfitLossForPeriod' in facts) &&
        !('ProfitLossForThePeriod' in facts)
      ) {
        continue;
      }
      basis = basis || 'standalone';
    }

    const auditedText = (facts['WhetherResultsAreAuditedOrUnaudited'] ?? '').trim().toLowerCase();
    const audited = auditedText ? !auditedText.includes('un') : null;

    reports.push({
      basis: basis as 'standalone' | 'consolidated',
      period: { start, end, kind: classify(start, end), months: monthsBetween(start, end) },
      audited,
      facts,
      periodInferred: inferred,
      contextDatesDisagree: disagree,
      // Both the quarter and the year-to-date end on the same day and both legitimately carry the
      // balance sheet: a position is not divided between them.
      instantFacts: instants.get(end) ?? {},
    });
  }

  if (reports.length === 0) {
    throw new UnparseableXbrl('no context carried a usable reporting period');
  }

  return {
    symbol: first('Symbol'),
    isin: first('ISIN'),
    companyName: first('NameOfTheCompany'),
    reports,
  };
}
