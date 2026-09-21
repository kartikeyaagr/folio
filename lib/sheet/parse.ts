/**
 * Formulas, from text to a tree.
 *
 * A recursive-descent parser over a small grammar, hand-written for the same reason the CSV reader
 * in `lib/ingest/nse.ts` is: it is eighty lines against a dependency, and the grammar is fixed by
 * fifty years of spreadsheet convention rather than by anything that will change here.
 *
 * Deliberately small. Numbers, strings, cell references, ranges, the five arithmetic operators,
 * comparisons, and function calls. No array formulas, no lambdas, no names — those are the parts of
 * a spreadsheet that people use to build software, and there is already somewhere to put software.
 *
 * **A reference may name a sheet**: `Notes!B2`, or `'Q1 FY26'!B2` where the name has a space in it.
 * That is the one piece of grammar without which a workbook is not a workbook — a model's inputs
 * live on one tab and its output on another, and until this parsed, every such formula was refused
 * at import and replaced by the number Excel last showed, which is a model that has stopped moving.
 */

import { parseRef, refName, type CellRef } from './cells.ts';

/**
 * `sheet` is the tab a reference reaches into, and `undefined` means the one the formula is on.
 * Not a default of "the first sheet": a relative reference and a reference to sheet one are
 * different claims, and they only coincide on a workbook with a single tab.
 */
export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; ref: CellRef; sheet?: string }
  | { t: 'range'; from: CellRef; to: CellRef; sheet?: string }
  | { t: 'op'; op: string; a: Node; b: Node }
  | { t: 'neg'; a: Node }
  | { t: 'call'; name: string; args: Node[] };

export class BadFormula extends Error {}

/** `sheet` is a single-quoted tab name; Excel quotes one exactly when it is not a bare word. */
type Token = { k: 'num' | 'str' | 'word' | 'punct' | 'sheet'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new BadFormula('a quoted string was never closed');
        if (src[i] === '"') {
          // "" is an escaped quote — the spreadsheet convention, not a backslash. Checked before
          // the closing quote, or the loop ends on the first half of the pair.
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += src[i];
        i++;
      }
      out.push({ k: 'str', v });
      continue;
    }
    // A single-quoted name is always a sheet, never a string — spreadsheets have no single-quoted
    // string literal. `'Don''t'!A1` doubles the apostrophe the same way a double-quoted string does.
    if (ch === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new BadFormula('a quoted sheet name was never closed');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += src[i];
        i++;
      }
      out.push({ k: 'sheet', v });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let v = '';
      while (i < src.length && /[0-9.]/.test(src[i]!)) { v += src[i]; i++; }
      out.push({ k: 'num', v });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let v = '';
      while (i < src.length && /[A-Za-z0-9_$.]/.test(src[i]!)) { v += src[i]; i++; }
      out.push({ k: 'word', v });
      continue;
    }
    // Two-character comparisons before one, or `<=` tokenizes as `<` then `=`.
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ k: 'punct', v: two }); i += 2; continue; }
    if ('+-*/^(),:<>=&%!'.includes(ch)) { out.push({ k: 'punct', v: ch }); i++; continue; }
    throw new BadFormula(`this formula contains a character it cannot read: ${ch}`);
  }
  return out;
}

/** Binding power, loosest first. Comparison binds least, so `A1+1 > B1` compares the sums. */
const PRECEDENCE: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};

export function parseFormula(source: string): Node {
  const src = source.startsWith('=') ? source.slice(1) : source;
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  // Punctuation only, which is every caller. Matching on the text alone would let a sheet named
  // `)` close a function call, and a tab may be named anything a person can type.
  const eat = (v: string): boolean => {
    const tok = tokens[pos];
    if (tok?.k === 'punct' && tok.v === v) { pos++; return true; }
    return false;
  };
  const expect = (v: string): void => {
    if (!eat(v)) throw new BadFormula(`expected ${v}`);
  };

  /** `A1` or `A1:B3`, on `sheet` when one was named and on the formula's own tab when not. */
  function refOrRange(sheet: string | undefined, word: string): Node {
    const from = parseRef(word);
    if (!from) {
      throw new BadFormula(
        sheet === undefined
          ? `${word} is not a cell or a function`
          : `${sheet}!${word} is not a cell`,
      );
    }
    if (eat(':')) {
      const next = peek();
      const to = next?.k === 'word' ? parseRef(next.v) : null;
      if (!to) throw new BadFormula('a range needs a second cell after the colon');
      pos++;
      return { t: 'range', from, to, sheet };
    }
    return { t: 'ref', ref: from, sheet };
  }

  /** What follows the `!` in `Notes!B2`. Refused where a whole column would go: `Notes!A:B`. */
  function afterSheet(sheet: string): Node {
    const next = peek();
    if (next?.k !== 'word') throw new BadFormula(`${sheet}! is not followed by a cell`);
    pos++;
    return refOrRange(sheet, next.v);
  }

  function primary(): Node {
    const tok = peek();
    if (!tok) throw new BadFormula('the formula ends before it says anything');
    if (tok.k === 'num') { pos++; return { t: 'num', v: Number(tok.v) }; }
    if (tok.k === 'str') { pos++; return { t: 'str', v: tok.v }; }
    if (tok.k === 'punct') {
      if (tok.v === '(') { pos++; const e = expression(0); expect(')'); return e; }
      if (tok.v === '-') { pos++; return { t: 'neg', a: primary() }; }
      if (tok.v === '+') { pos++; return primary(); }
    }

    // A quoted name is only ever a tab, so it must be followed by the `!` that reaches into one.
    if (tok.k === 'sheet') {
      pos++;
      if (!eat('!')) throw new BadFormula(`'${tok.v}' is a sheet name and nothing follows its !`);
      return afterSheet(tok.v);
    }

    if (tok.k === 'word') {
      pos++;
      if (eat('(')) {
        const args: Node[] = [];
        if (!eat(')')) {
          do { args.push(expression(0)); } while (eat(','));
          expect(')');
        }
        return { t: 'call', name: tok.v.toUpperCase(), args };
      }
      // Tested before the word is read as a cell, so a tab legitimately named `A1` still works.
      if (eat('!')) return afterSheet(tok.v);
      return refOrRange(undefined, tok.v);
    }
    throw new BadFormula(`unexpected ${tok.v}`);
  }

  function expression(min: number): Node {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.k !== 'punct') break;
      const bindingPower = PRECEDENCE[tok.v];
      if (bindingPower === undefined || bindingPower < min) break;
      pos++;
      // `^` is right-associative, so 2^3^2 is 2^9 and not 8^2 — the one operator where it matters.
      const right = expression(tok.v === '^' ? bindingPower : bindingPower + 1);
      left = { t: 'op', op: tok.v, a: left, b: right };
    }
    return left;
  }

  const tree = expression(0);
  if (pos < tokens.length) throw new BadFormula(`this formula has something left over: ${tokens[pos]!.v}`);
  return tree;
}

/**
 * A tree back into a formula.
 *
 * Exists for one job: renaming a tab has to rewrite the formulas that name it, or every reference
 * into that tab becomes `#REF!` the moment somebody tidies a title. Excel rewrites them and so does
 * this, which means round-tripping `=(A1+B1)*2` has to come back out with its brackets — dropping
 * them would change the answer, and it would change it in a cell nobody had touched.
 */
export function printFormula(node: Node): string {
  switch (node.t) {
    case 'num': return String(node.v);
    case 'str': return `"${node.v.replace(/"/g, '""')}"`;
    case 'ref': return `${sheetPrefix(node.sheet)}${refName(node.ref)}`;
    case 'range':
      return `${sheetPrefix(node.sheet)}${refName(node.from)}:${refName(node.to)}`;
    case 'call': return `${node.name}(${node.args.map(printFormula).join(',')})`;
    // `-` binds tighter than every operator here, so anything compound under it keeps its brackets.
    case 'neg': return `-${node.a.t === 'op' ? `(${printFormula(node.a)})` : printFormula(node.a)}`;
    case 'op': {
      const bindingPower = PRECEDENCE[node.op]!;
      return `${side(node.a, bindingPower, node.op, false)}${node.op}${side(node.b, bindingPower, node.op, true)}`;
    }
  }
}

/** A tab name, quoted exactly when a bare word would not lex back to the same name. */
function sheetPrefix(sheet: string | undefined): string {
  if (sheet === undefined) return '';
  return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(sheet)
    ? `${sheet}!`
    : `'${sheet.replace(/'/g, "''")}'!`;
}

/** One operand, bracketed only where dropping the brackets would change what it means. */
function side(child: Node, parentBindingPower: number, parentOp: string, isRight: boolean): string {
  const printed = printFormula(child);
  if (child.t !== 'op') return printed;
  const bindingPower = PRECEDENCE[child.op]!;
  if (bindingPower < parentBindingPower) return `(${printed})`;
  // Equal binding: `a-(b-c)` keeps its brackets, and so does `(a^b)^c` — on the other side,
  // because `^` is the one right-associative operator here.
  if (bindingPower === parentBindingPower && isRight !== (parentOp === '^')) return `(${printed})`;
  return printed;
}

/**
 * Point every reference at `to` that pointed at `from`.
 *
 * Null when the formula does not mention the tab, so a caller can leave a cell exactly as the
 * author typed it rather than round-tripping every formula in the workbook through the printer —
 * which would be correct and would still rewrite `=A1 + B1` to `=A1+B1` under somebody's cursor.
 */
export function renameSheetIn(formula: string, from: string, to: string): string | null {
  let tree: Node;
  try {
    tree = parseFormula(formula);
  } catch {
    return null; // A formula that will not parse has no references to move.
  }
  const wanted = from.trim().toLowerCase();
  let touched = false;

  const walk = (node: Node): Node => {
    switch (node.t) {
      case 'ref':
      case 'range':
        if (node.sheet !== undefined && node.sheet.trim().toLowerCase() === wanted) {
          touched = true;
          return { ...node, sheet: to };
        }
        return node;
      case 'op': return { ...node, a: walk(node.a), b: walk(node.b) };
      case 'neg': return { ...node, a: walk(node.a) };
      case 'call': return { ...node, args: node.args.map(walk) };
      default: return node;
    }
  };

  const next = walk(tree);
  return touched ? `=${printFormula(next)}` : null;
}

/** Every function name a formula calls, so its data lookups can be resolved before evaluation. */
export function callsIn(node: Node, into: Node[] = []): Node[] {
  if (node.t === 'call') {
    into.push(node);
    for (const a of node.args) callsIn(a, into);
  } else if (node.t === 'op') {
    callsIn(node.a, into);
    callsIn(node.b, into);
  } else if (node.t === 'neg') {
    callsIn(node.a, into);
  }
  return into;
}
