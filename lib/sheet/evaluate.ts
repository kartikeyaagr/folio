/**
 * Working out what a grid says.
 *
 * **Pure.** The data functions — the ones that read this system's own figures — are resolved before
 * evaluation and handed in as a map, so this file has no database, no network and no clock, and its
 * tests need none either. `./data.ts` does the fetching; two phases rather than an async evaluator
 * whose every cell could be a round trip.
 *
 * Errors are values, as they are in every spreadsheet: a cell that cannot be worked out holds
 * `#DIV/0!` and the cells referring to it hold the same, so a mistake is visible where it happened
 * and where it spread. **`#N/A` is the important one** — it is what a data function returns when
 * this system has no figure, and it is deliberately not zero. A model whose missing revenue reads
 * as zero produces a margin, a growth rate and a valuation, all of them wrong and none of them
 * marked. That is the same argument `<Blank>` makes on every screen here.
 */

import { expandRange, refName, type CellRef } from './cells.ts';
import { parseFormula, type Node } from './parse.ts';

export type Value = number | string | boolean | CellError;

/**
 * A cell that could not be worked out.
 *
 * A plain object, not a class. A class instance cannot cross from a server component into a client
 * one — React refuses it with "Classes or null prototypes are not supported" — and the grid is a
 * client component handed its resolved figures by the server. Errors are values here in every
 * sense, this one included.
 */
export interface CellError {
  readonly err: string;
  readonly detail: string;
}

export const isCellError = (v: unknown): v is CellError =>
  typeof v === 'object' && v !== null && 'err' in v && 'detail' in v;

const cellError = (err: string, detail: string): CellError => ({ err, detail });

export const NA = (detail: string) => cellError('#N/A', detail);
const DIV0 = () => cellError('#DIV/0!', 'divided by zero');
const CYCLE = (at: string) => cellError('#CYCLE!', `${at} depends on itself`);
const NAME = (fn: string) => cellError('#NAME?', `no function called ${fn}`);
const VALUE = (detail: string) => cellError('#VALUE!', detail);

/**
 * The functions answered from this system's own figures rather than computed here.
 *
 * The names live in this file so that a typo can be told from a lookup: without them every
 * unrecognised call would resolve to a missing data figure and report `#N/A`, so `=XLOOKUP(...)`
 * would read as "we hold no such figure" rather than "there is no such function". `./data.ts`
 * imports this and attaches what each one takes and answers.
 */
export const DATA_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  'FIN', 'CLOSE', 'QTY', 'AVGCOST', 'PROMOTER',
]);

export type Cells = Record<string, string>;
/** Answers for the data calls in this grid, keyed by `./data.ts`'s canonical call string. */
export type Lookups = Record<string, Value>;

const isErr = isCellError;

/** A number, or the reason it is not one. Blank counts as zero only inside arithmetic. */
function num(v: Value): number | CellError {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isErr(v)) return v;
  const t = v.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : VALUE(`${v} is not a number`);
}

const text = (v: Value): string =>
  isErr(v) ? v.err : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);

/** The literal in a cell: a number if it reads as one, otherwise the text as typed. */
export function literal(raw: string): Value {
  const t = raw.trim();
  if (t === '') return '';
  if (/^-?(\d+\.?\d*|\.\d+)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : raw;
}

export interface Sheet {
  /** Raw text per address, exactly as typed. */
  cells: Cells;
  lookups?: Lookups;
}

/**
 * Evaluate every cell that has anything in it.
 *
 * Cycles are found by the visiting set rather than by a topological sort up front, because the
 * common case is a grid with no cycle at all and walking it lazily costs nothing. A cell caught in
 * one holds `#CYCLE!` and so does everything downstream, which is how a person finds the loop.
 */
export function evaluateSheet(sheet: Sheet): Record<string, Value> {
  const out: Record<string, Value> = {};
  const visiting = new Set<string>();
  const lookups = sheet.lookups ?? {};

  function valueAt(name: string): Value {
    if (name in out) return out[name]!;
    const raw = sheet.cells[name];
    if (raw === undefined || raw.trim() === '') return '';
    if (visiting.has(name)) return CYCLE(name);

    visiting.add(name);
    let v: Value;
    if (raw.trimStart().startsWith('=')) {
      try {
        v = evalNode(parseFormula(raw.trimStart()));
      } catch (err) {
        v = cellError('#ERROR!', err instanceof Error ? err.message : String(err));
      }
    } else {
      v = literal(raw);
    }
    visiting.delete(name);
    out[name] = v;
    return v;
  }

  function at(ref: CellRef): Value {
    return valueAt(refName(ref));
  }

  /** A function's arguments flattened: ranges spread, so SUM(A1:A3, B1) is four values. */
  function spread(args: Node[]): Value[] {
    const vs: Value[] = [];
    for (const a of args) {
      if (a.t === 'range') {
        for (const ref of expandRange(a.from, a.to)) vs.push(at(ref));
      } else {
        vs.push(evalNode(a));
      }
    }
    return vs;
  }

  function numbers(vs: Value[]): number[] | CellError {
    const out: number[] = [];
    for (const v of vs) {
      if (isErr(v)) return v;
      // Blanks and text are skipped rather than counted as zero — SUM over a column with a heading
      // is the single most common thing anybody does, and it must not read the heading as 0.
      if (v === '' || typeof v === 'string') continue;
      const n = num(v);
      if (isErr(n)) return n;
      out.push(n);
    }
    return out;
  }

  function call(name: string, args: Node[]): Value {
    // IF before the arguments are evaluated, so the untaken branch cannot raise an error the
    // formula deliberately avoided.
    if (name === 'IF') {
      if (args.length < 2) return VALUE('IF needs a test and a value');
      const test = evalNode(args[0]!);
      if (isErr(test)) return test;
      let truthy: boolean;
      if (typeof test === 'boolean') {
        truthy = test;
      } else {
        const n = num(test);
        if (isErr(n)) return n;
        truthy = n !== 0;
      }
      const branch = truthy ? args[1] : args[2];
      return branch === undefined ? false : evalNode(branch);
    }

    const vs = spread(args);
    const first = vs.find(isErr);

    switch (name) {
      case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': case 'PRODUCT': case 'STDEV': {
        const ns = numbers(vs);
        if (isErr(ns)) return ns;
        if (name === 'SUM') return ns.reduce((a, b) => a + b, 0);
        if (name === 'PRODUCT') return ns.reduce((a, b) => a * b, 1);
        if (ns.length === 0) return DIV0();
        if (name === 'AVERAGE') return ns.reduce((a, b) => a + b, 0) / ns.length;
        if (name === 'MIN') return Math.min(...ns);
        if (name === 'MAX') return Math.max(...ns);
        const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
        if (ns.length < 2) return DIV0();
        return Math.sqrt(ns.reduce((t, x) => t + (x - mean) ** 2, 0) / (ns.length - 1));
      }
      case 'COUNT': {
        const ns = numbers(vs);
        return isErr(ns) ? ns : ns.length;
      }
      case 'COUNTA':
        return vs.filter((v) => v !== '').length;
      case 'ROUND': {
        if (first) return first;
        const n = num(vs[0] ?? 0);
        const d = num(vs[1] ?? 0);
        if (isErr(n)) return n;
        if (isErr(d)) return d;
        const f = 10 ** d;
        return Math.round(n * f) / f;
      }
      case 'ABS': case 'SQRT': case 'LN': {
        if (first) return first;
        const n = num(vs[0] ?? 0);
        if (isErr(n)) return n;
        if (name === 'ABS') return Math.abs(n);
        if (name === 'SQRT') return n < 0 ? VALUE('the square root of a negative') : Math.sqrt(n);
        return n <= 0 ? VALUE('the log of a non-positive number') : Math.log(n);
      }
      case 'CONCAT':
        return vs.map(text).join('');
      case 'IFERROR':
        return vs[0] !== undefined && isErr(vs[0]) ? (vs[1] ?? '') : (vs[0] ?? '');
      case 'ISBLANK':
        return vs[0] === '' || vs[0] === undefined;
      default:
        break;
    }

    // A data function: its answer was resolved before evaluation. Anything else is a typo, and
    // saying so is the difference between "no such function" and "we hold no such figure".
    if (!DATA_FUNCTION_NAMES.has(name)) return NAME(name);
    const key = callKey(name, vs);
    if (key === null) return NA('this call\u2019s arguments are computed, so it cannot be looked up');
    return key in lookups ? lookups[key]! : NA('this figure was not resolved');
  }

  function evalNode(node: Node): Value {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'ref': return at(node.ref);
      case 'range': {
        // A bare range where one value is wanted takes its first cell, as every spreadsheet does.
        const [head] = expandRange(node.from, node.to);
        return head ? at(head) : VALUE('an empty range');
      }
      case 'neg': {
        const n = num(evalNode(node.a));
        return isErr(n) ? n : -n;
      }
      case 'call': return call(node.name, node.args);
      case 'op': {
        const a = evalNode(node.a);
        const b = evalNode(node.b);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (node.op === '&') return text(a) + text(b);
        if (node.op === '=') return text(a) === text(b);
        if (node.op === '<>') return text(a) !== text(b);
        const x = num(a);
        const y = num(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        switch (node.op) {
          case '+': return x + y;
          case '-': return x - y;
          case '*': return x * y;
          case '/': return y === 0 ? DIV0() : x / y;
          case '^': return x ** y;
          case '<': return x < y;
          case '>': return x > y;
          case '<=': return x <= y;
          case '>=': return x >= y;
          default: return VALUE(`unknown operator ${node.op}`);
        }
      }
    }
  }

  for (const name of Object.keys(sheet.cells)) valueAt(name);
  return out;
}

/**
 * The canonical form of a data call, used as the key on both sides of the two phases.
 *
 * Arguments are stringified and upper-cased, so `REVENUE("prajind","FY26")` and
 * `Revenue("PRAJIND","fy26")` are one lookup rather than two. Returns null when an argument is not
 * a literal, because a data function whose arguments are themselves computed cannot be resolved
 * before evaluation — and pretending otherwise would silently return the wrong company's figure.
 */
export function callKey(name: string, args: Value[]): string | null {
  const parts: string[] = [];
  for (const a of args) {
    if (isErr(a)) return null;
    parts.push(String(a).trim().toUpperCase());
  }
  return `${name}(${parts.join('|')})`;
}
