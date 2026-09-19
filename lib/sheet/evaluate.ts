/**
 * Working out what a workbook says.
 *
 * **Pure.** The data functions — the ones that read this system's own figures — are resolved before
 * evaluation and handed in as a map, so this file has no database, no network and no clock, and its
 * tests need none either. `./data.ts` does the fetching; two phases rather than an async evaluator
 * whose every cell could be a round trip.
 *
 * **A workbook, not a grid.** Every tab is evaluated in one pass against one namespace, because
 * `=Model!B4` is only answerable if the sheet holding the answer is in scope while the sheet asking
 * is being walked. Evaluating tabs one at a time — which is what this did until tabs existed — is
 * what made a cross-sheet formula unanswerable, and therefore what made the importer drop it.
 *
 * `./values.ts` says what a value is and `./functions.ts` says what the named functions do with
 * one; both are re-exported here so nothing outside `lib/sheet/` has to know about the split.
 */

import { expandRange, refName, type CellRef } from './cells.ts';
import { callFunction } from './functions.ts';
import { parseFormula, type Node } from './parse.ts';
import {
  CYCLE, DIV0, ERROR, isCellError, literal, num, REF, text, VALUE,
  type Cells, type Lookups, type Value,
} from './values.ts';

export {
  callKey, DATA_FUNCTION_NAMES, isCellError, literal, NA,
  type CellError, type Cells, type Lookups, type Value,
} from './values.ts';

/** One tab: what it is called, and what is typed in it. */
export interface Grid {
  name: string;
  cells: Cells;
}

export interface Workbook {
  sheets: Grid[];
  lookups?: Lookups;
}

/** One grid on its own — the shape this file took before a document could hold several. */
export interface Sheet {
  /** Raw text per address, exactly as typed. */
  cells: Cells;
  lookups?: Lookups;
}

/**
 * Evaluate every cell in every tab.
 *
 * Answers parallel to `sheets`, so the caller indexes by position and never has to care that two
 * tabs could be called the same thing.
 *
 * Cycles are found by the visiting set rather than by a topological sort up front, because the
 * common case is a workbook with no cycle at all and walking it lazily costs nothing. The set is
 * keyed by tab *and* address, so `Model!A1 -> Notes!A1 -> Model!A1` is caught the same way a loop
 * inside one tab is. A cell caught in one holds `#CYCLE!` and so does everything downstream, which
 * is how a person finds the loop.
 */
export function evaluateWorkbook(book: Workbook): Record<string, Value>[] {
  const lookups = book.lookups ?? {};
  const out: Record<string, Value>[] = book.sheets.map(() => ({}));
  const visiting = new Set<string>();

  // Excel forbids two tabs with one name and matches a reference case-insensitively, so this does
  // both: lower-cased keys, and the first tab wins if a hand-written body ever breaks the rule.
  const byName = new Map<string, number>();
  book.sheets.forEach((s, i) => {
    const key = s.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, i);
  });

  /** Which tab a reference means: the one it was written on, unless it named another. */
  function sheetIndex(named: string | undefined, here: number): number | null {
    if (named === undefined) return here;
    return byName.get(named.trim().toLowerCase()) ?? null;
  }

  function valueAt(si: number, name: string): Value {
    const sheet = book.sheets[si];
    if (!sheet) return REF(`there is no tab ${si + 1} in this workbook`);
    const answers = out[si]!;
    if (name in answers) return answers[name]!;
    const raw = sheet.cells[name];
    if (raw === undefined || raw.trim() === '') return '';

    const mark = `${si}!${name}`;
    if (visiting.has(mark)) return CYCLE(`${sheet.name ? `${sheet.name}!` : ''}${name}`);

    visiting.add(mark);
    let v: Value;
    if (raw.trimStart().startsWith('=')) {
      try {
        v = evalNode(parseFormula(raw.trimStart()), si);
      } catch (err) {
        v = ERROR(err instanceof Error ? err.message : String(err));
      }
    } else {
      v = literal(raw);
    }
    visiting.delete(mark);
    answers[name] = v;
    return v;
  }

  /** A reference, once the tab it names has been resolved. */
  function at(ref: CellRef, named: string | undefined, here: number): Value {
    const si = sheetIndex(named, here);
    // Named and not found: the tab was renamed or deleted after the formula was written. Said as
    // `#REF!` with the name in it, because "which tab" is the only thing the reader needs.
    if (si === null) return REF(`there is no tab called ${named ?? ''} in this workbook`);
    return valueAt(si, refName(ref));
  }

  /** A function's arguments flattened: ranges spread, so SUM(A1:A3, B1) is four values. */
  function spread(args: Node[], si: number): Value[] {
    const vs: Value[] = [];
    for (const a of args) {
      if (a.t === 'range') {
        for (const ref of expandRange(a.from, a.to)) vs.push(at(ref, a.sheet, si));
      } else {
        vs.push(evalNode(a, si));
      }
    }
    return vs;
  }

  function evalNode(node: Node, si: number): Value {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'ref': return at(node.ref, node.sheet, si);
      case 'range': {
        // A bare range where one value is wanted takes its first cell, as every spreadsheet does.
        const [head] = expandRange(node.from, node.to);
        return head ? at(head, node.sheet, si) : VALUE('an empty range');
      }
      case 'neg': {
        const n = num(evalNode(node.a, si));
        return isCellError(n) ? n : -n;
      }
      case 'call':
        return callFunction(node.name, node.args, {
          spread: (args) => spread(args, si),
          evaluate: (n) => evalNode(n, si),
          lookups,
        });
      case 'op': {
        const a = evalNode(node.a, si);
        const b = evalNode(node.b, si);
        if (isCellError(a)) return a;
        if (isCellError(b)) return b;
        return operate(node.op, a, b);
      }
    }
  }

  book.sheets.forEach((sheet, si) => {
    for (const name of Object.keys(sheet.cells)) valueAt(si, name);
  });
  return out;
}

/** Evaluate one grid on its own. Every cross-sheet reference in it is a `#REF!`, correctly. */
export function evaluateSheet(sheet: Sheet): Record<string, Value> {
  const book: Workbook = { sheets: [{ name: '', cells: sheet.cells }] };
  if (sheet.lookups) book.lookups = sheet.lookups;
  return evaluateWorkbook(book)[0]!;
}

// The operators, kept out of the walker so the walker reads as a walk. Both operands are already
// known not to be errors; comparison is on text so that `="a"="A"` behaves as a spreadsheet does.
function operate(op: string, a: Value, b: Value): Value {
  if (op === '&') return text(a) + text(b);
  if (op === '=') return text(a) === text(b);
  if (op === '<>') return text(a) !== text(b);

  const x = num(a);
  const y = num(b);
  if (isCellError(x)) return x;
  if (isCellError(y)) return y;

  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? DIV0() : x / y;
    case '^': return x ** y;
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    default: return VALUE(`unknown operator ${op}`);
  }
}
