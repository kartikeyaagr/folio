/**
 * The functions that read this system's own figures.
 *
 * The reason a model belongs in here rather than in Excel. `=FIN("PRAJIND","revenue","FY26")` is a
 * number that came out of a filing this box parsed, and it moves when the next quarter lands —
 * where the same number pasted into a spreadsheet is a number somebody typed in March and nobody
 * has checked since.
 *
 * **Resolved before evaluation, in one pass.** `./evaluate.ts` is pure and synchronous; this
 * collects every data call in a grid, answers them all in a single transaction, and hands back the
 * map it evaluates against. A cell is not a round trip.
 *
 * **A figure this system does not hold answers `#N/A`, never zero.** The whole argument for
 * `<Blank>` applies harder here: a blank cell in a model propagates into a margin, a growth rate
 * and a valuation, and none of them will be marked as resting on nothing.
 */

import { readTxn } from '../db.ts';
import {
  callKey, DATA_FUNCTION_NAMES, literal, NA, type Grid, type Lookups, type Value,
} from './evaluate.ts';
import { callsIn, parseFormula } from './parse.ts';

/** What each function takes, and one line on what it answers. Rendered in the sheet's help. */
export const DATA_FUNCTIONS: { name: string; args: string; what: string }[] = [
  { name: 'FIN', args: 'symbol, line, period, [basis]', what: 'A reported figure, in rupees. Period is FY26, Q1FY26, or a date like 2026-06-30.' },
  { name: 'CLOSE', args: 'symbol, [date]', what: 'The closing price on a date, or the latest held before it.' },
  { name: 'QTY', args: 'symbol', what: 'Shares held in the book today.' },
  { name: 'AVGCOST', args: 'symbol', what: 'Average cost of the holding, in rupees per share.' },
  { name: 'PROMOTER', args: 'symbol, [as of]', what: 'Promoter holding as a percentage, from the latest pattern filed on or before the date.' },
];

export const isDataFunction = (name: string): boolean =>
  DATA_FUNCTION_NAMES.has(name.toUpperCase());

/**
 * Turn a period argument into the period it names.
 *
 * `FY26` is the year to 31-Mar-2026, which is how this desk says it and how every Indian filing is
 * labelled. `Q1FY26` is the quarter to 30-Jun-2025 — the first quarter of the year *ending* March
 * 2026 — which is the one genuinely confusing convention here and the reason it is written down.
 * An ISO date is taken as the period end exactly.
 */
export function periodEnd(text: string): { end: string; kind: string | null } | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { end: t, kind: null };

  const fy = /^FY(\d{2}|\d{4})$/.exec(t);
  if (fy) {
    const y = fy[1]!.length === 2 ? 2000 + Number(fy[1]) : Number(fy[1]);
    return { end: `${y}-03-31`, kind: 'year' };
  }
  const q = /^Q([1-4])FY(\d{2}|\d{4})$/.exec(t);
  if (q) {
    const y = q[2]!.length === 2 ? 2000 + Number(q[2]) : Number(q[2]);
    // Q1 of FY26 ends June 2025, so the calendar year is one behind for the first three quarters.
    const ends = ['06-30', '09-30', '12-31', '03-31'];
    const n = Number(q[1]);
    return { end: `${n === 4 ? y : y - 1}-${ends[n - 1]}`, kind: 'quarter' };
  }
  return null;
}

interface Call {
  key: string;
  name: string;
  args: string[];
}

/**
 * Every data call in a workbook, canonicalised and deduplicated.
 *
 * Across every tab, into one map. `=FIN("PRAJIND","revenue","FY26")` on the Inputs tab and the
 * same call on the Model tab are one question, asked once — and the map `evaluateWorkbook` is
 * handed is workbook-wide for the same reason its cell namespace is.
 */
export function collectCalls(sheets: readonly Grid[]): Call[] {
  const found = new Map<string, Call>();
  for (const sheet of sheets) {
    for (const raw of Object.values(sheet.cells)) {
      if (!raw.trimStart().startsWith('=')) continue;
      let tree;
      try {
        tree = parseFormula(raw.trimStart());
      } catch {
        continue; // A formula that will not parse has no calls to resolve; the cell reports it.
      }
      for (const node of callsIn(tree)) {
        if (node.t !== 'call' || !isDataFunction(node.name)) continue;
        // Literal arguments only. A data call whose company is itself computed cannot be resolved
        // before evaluation, and guessing would fetch the wrong company's figure in silence.
        const args: string[] = [];
        let literalOnly = true;
        for (const a of node.args) {
          if (a.t === 'str') args.push(a.v);
          else if (a.t === 'num') args.push(String(a.v));
          else literalOnly = false;
        }
        if (!literalOnly) continue;
        const key = callKey(node.name.toUpperCase(), args);
        if (key !== null && !found.has(key)) {
          found.set(key, { key, name: node.name.toUpperCase(), args });
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * Answer every call, in one transaction.
 *
 * One query per distinct call rather than one clever join: a grid has a handful of distinct
 * lookups even when it has hundreds of cells, they are all indexed, and a readable query that is
 * obviously about one figure is worth more here than a fast one nobody can check.
 */
export async function resolveCalls(calls: Call[]): Promise<Lookups> {
  if (calls.length === 0) return {};
  return readTxn(async (c) => {
    const out: Lookups = {};
    for (const call of calls) {
      const symbol = (call.args[0] ?? '').trim().toUpperCase();
      if (!symbol) {
        out[call.key] = NA('no company named');
        continue;
      }
      out[call.key] = await answer(c, call, symbol);
    }
    return out;
  });
}

type Client = Parameters<Parameters<typeof readTxn>[0]>[0];

async function answer(c: Client, call: Call, symbol: string): Promise<Value> {
  switch (call.name) {
    case 'FIN': {
      const line = (call.args[1] ?? '').trim().toLowerCase();
      const period = periodEnd(call.args[2] ?? '');
      if (!line) return NA('no line item named');
      if (!period) return NA(`${call.args[2] ?? ''} is not a period this understands`);
      const basis = (call.args[3] ?? 'consolidated').trim().toLowerCase();
      // The basis filters, it does not merely sort.
      //
      // This read ORDER BY (f.basis = $5) DESC until 21-Sep-2026, which preferred the basis asked
      // for when a row existed and returned the other one when it did not. A model asking for
      // consolidated revenue got the standalone figure, unmarked — and standalone and consolidated
      // are materially different numbers for a company with subsidiaries.
      //
      // That is the failure this module's header exists to forbid, one step worse than the blank
      // it refuses: a plausible wrong number propagates into a margin, a growth rate and a
      // valuation exactly as far as a blank would, and does not look wrong on the way.
      const { rows } = await c.query<{ v: string | null }>(
        `SELECT f.facts ->> $3 AS v
           FROM fundamentals f JOIN companies co ON co.id = f.company_id
          WHERE co.symbol = $1 AND f.superseded_by IS NULL AND f.period_end = $2::date
            AND f.basis = $5
            AND ($4 = '' OR f.period_kind = $4)
          LIMIT 1`,
        [symbol, period.end, line, period.kind ?? '', basis],
      );
      const v = rows[0]?.v;
      return v == null || v === ''
        ? NA(`no ${basis} ${line} filed for ${symbol} to ${period.end}`)
        : Number(v);
    }
    case 'CLOSE': {
      const on = (call.args[1] ?? '').trim();
      const { rows } = await c.query<{ close: string }>(
        `SELECT p.close::text FROM prices p
          WHERE p.symbol = $1 AND ($2 = '' OR p.on_date <= $2::date)
          ORDER BY p.on_date DESC LIMIT 1`,
        [symbol, /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : ''],
      );
      return rows[0] ? Number(rows[0].close) : NA(`no close held for ${symbol}`);
    }
    case 'QTY':
    case 'AVGCOST': {
      const { rows } = await c.query<{ quantity: string; avg_cost: string }>(
        `SELECT h.quantity::text, h.avg_cost::text FROM holdings h
           JOIN companies co ON co.id = h.company_id WHERE co.symbol = $1`,
        [symbol],
      );
      const h = rows[0];
      if (!h) return NA(`${symbol} is not on the book`);
      return Number(call.name === 'QTY' ? h.quantity : h.avg_cost);
    }
    case 'PROMOTER': {
      const on = (call.args[1] ?? '').trim();
      const { rows } = await c.query<{ pct: string | null }>(
        `SELECT s.promoter_pct::text AS pct FROM shareholding_patterns s
           JOIN companies co ON co.id = s.company_id
          WHERE co.symbol = $1 AND ($2 = '' OR s.as_of <= $2::date)
          ORDER BY s.as_of DESC LIMIT 1`,
        [symbol, /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : ''],
      );
      const pct = rows[0]?.pct;
      return pct == null ? NA(`no shareholding pattern held for ${symbol}`) : Number(pct);
    }
    default:
      return NA(`${call.name} is not a data function`);
  }
}

/** Everything a workbook needs: its own cells, plus the figures every tab asks this box for. */
export async function lookupsFor(sheets: readonly Grid[]): Promise<Lookups> {
  return resolveCalls(collectCalls(sheets));
}

export { literal };
