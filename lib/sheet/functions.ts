/**
 * The built-in functions.
 *
 * Split from `./evaluate.ts`, which owns getting from an address to a value — including, now, an
 * address on another tab. This file owns what the named functions do once their arguments have
 * values, and it reaches back into the evaluator only through `Context`: `spread` for the usual
 * case where every argument is wanted, and `evaluate` for `IF`, which must not evaluate the branch
 * it did not take.
 *
 * Deliberately short. A fund's model is arithmetic, ratios and the occasional `IF`; the functions
 * people reach for beyond this — `VLOOKUP`, `XLOOKUP`, `INDEX/MATCH` — are how a spreadsheet gets
 * used to build software, and `./data.ts` is where this system answers that need honestly instead.
 */

import type { Node } from './parse.ts';
import {
  callKey, DATA_FUNCTION_NAMES, DIV0, isCellError, NA, NAME, num, text, VALUE,
  type CellError, type Lookups, type Value,
} from './values.ts';

export interface Context {
  /** Every argument evaluated, with ranges spread flat: `SUM(A1:A3, B1)` is four values. */
  spread(args: Node[]): Value[];
  /** One argument, evaluated on demand. Only `IF` needs this. */
  evaluate(node: Node): Value;
  lookups: Lookups;
}

function numbers(values: Value[]): number[] | CellError {
  const out: number[] = [];
  for (const v of values) {
    if (isCellError(v)) return v;
    // Blanks and text are skipped rather than counted as zero — SUM over a column with a heading
    // is the single most common thing anybody does, and it must not read the heading as 0.
    if (v === '' || typeof v === 'string') continue;
    const n = num(v);
    if (isCellError(n)) return n;
    out.push(n);
  }
  return out;
}

export function callFunction(name: string, args: Node[], ctx: Context): Value {
  // IF before the arguments are evaluated, so the untaken branch cannot raise an error the
  // formula deliberately avoided.
  if (name === 'IF') {
    if (args.length < 2) return VALUE('IF needs a test and a value');
    const test = ctx.evaluate(args[0]!);
    if (isCellError(test)) return test;
    let truthy: boolean;
    if (typeof test === 'boolean') {
      truthy = test;
    } else {
      const n = num(test);
      if (isCellError(n)) return n;
      truthy = n !== 0;
    }
    const branch = truthy ? args[1] : args[2];
    return branch === undefined ? false : ctx.evaluate(branch);
  }

  const values = ctx.spread(args);
  const first = values.find(isCellError);

  switch (name) {
    case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': case 'PRODUCT': case 'STDEV': {
      const numericValues = numbers(values);
      if (isCellError(numericValues)) return numericValues;
      if (name === 'SUM') return numericValues.reduce((a, b) => a + b, 0);
      if (name === 'PRODUCT') return numericValues.reduce((a, b) => a * b, 1);
      if (numericValues.length === 0) return DIV0();
      if (name === 'AVERAGE') return numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      if (name === 'MIN') return Math.min(...numericValues);
      if (name === 'MAX') return Math.max(...numericValues);
      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      if (numericValues.length < 2) return DIV0();
      return Math.sqrt(numericValues.reduce((t, x) => t + (x - mean) ** 2, 0) / (numericValues.length - 1));
    }
    case 'COUNT': {
      const numericValues = numbers(values);
      return isCellError(numericValues) ? numericValues : numericValues.length;
    }
    case 'COUNTA':
      return values.filter((v) => v !== '').length;
    case 'ROUND': {
      if (first) return first;
      const n = num(values[0] ?? 0);
      const d = num(values[1] ?? 0);
      if (isCellError(n)) return n;
      if (isCellError(d)) return d;
      const f = 10 ** d;
      return Math.round(n * f) / f;
    }
    case 'ABS': case 'SQRT': case 'LN': {
      if (first) return first;
      const n = num(values[0] ?? 0);
      if (isCellError(n)) return n;
      if (name === 'ABS') return Math.abs(n);
      if (name === 'SQRT') return n < 0 ? VALUE('the square root of a negative') : Math.sqrt(n);
      return n <= 0 ? VALUE('the log of a non-positive number') : Math.log(n);
    }
    case 'CONCAT':
      return values.map(text).join('');
    case 'IFERROR':
      return values[0] !== undefined && isCellError(values[0]) ? (values[1] ?? '') : (values[0] ?? '');
    case 'ISBLANK':
      return values[0] === '' || values[0] === undefined;
    default:
      break;
  }

  // A data function: its answer was resolved before evaluation. Anything else is a typo, and
  // saying so is the difference between "no such function" and "we hold no such figure".
  if (!DATA_FUNCTION_NAMES.has(name)) return NAME(name);
  const key = callKey(name, values);
  if (key === null) return NA('this call’s arguments are computed, so it cannot be looked up');
  return key in ctx.lookups ? ctx.lookups[key]! : NA('this figure was not resolved');
}
