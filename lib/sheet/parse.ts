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
 */

import { parseRef, type CellRef } from './cells.ts';

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; ref: CellRef }
  | { t: 'range'; from: CellRef; to: CellRef }
  | { t: 'op'; op: string; a: Node; b: Node }
  | { t: 'neg'; a: Node }
  | { t: 'call'; name: string; args: Node[] };

export class BadFormula extends Error {}

type Token = { k: 'num' | 'str' | 'word' | 'punct'; v: string };

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
    if ('+-*/^(),:<>=&%'.includes(ch)) { out.push({ k: 'punct', v: ch }); i++; continue; }
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
  const eat = (v: string): boolean => {
    if (tokens[pos]?.v === v) { pos++; return true; }
    return false;
  };
  const expect = (v: string): void => {
    if (!eat(v)) throw new BadFormula(`expected ${v}`);
  };

  function primary(): Node {
    const tok = peek();
    if (!tok) throw new BadFormula('the formula ends before it says anything');
    if (tok.k === 'num') { pos++; return { t: 'num', v: Number(tok.v) }; }
    if (tok.k === 'str') { pos++; return { t: 'str', v: tok.v }; }
    if (tok.v === '(') { pos++; const e = expression(0); expect(')'); return e; }
    if (tok.v === '-') { pos++; return { t: 'neg', a: primary() }; }
    if (tok.v === '+') { pos++; return primary(); }

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
      const from = parseRef(tok.v);
      if (!from) throw new BadFormula(`${tok.v} is not a cell or a function`);
      if (eat(':')) {
        const next = peek();
        const to = next?.k === 'word' ? parseRef(next.v) : null;
        if (!to) throw new BadFormula('a range needs a second cell after the colon');
        pos++;
        return { t: 'range', from, to };
      }
      return { t: 'ref', ref: from };
    }
    throw new BadFormula(`unexpected ${tok.v}`);
  }

  function expression(min: number): Node {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.k !== 'punct') break;
      const bp = PRECEDENCE[tok.v];
      if (bp === undefined || bp < min) break;
      pos++;
      // `^` is right-associative, so 2^3^2 is 2^9 and not 8^2 — the one operator where it matters.
      const right = expression(tok.v === '^' ? bp : bp + 1);
      left = { t: 'op', op: tok.v, a: left, b: right };
    }
    return left;
  }

  const tree = expression(0);
  if (pos < tokens.length) throw new BadFormula(`this formula has something left over: ${tokens[pos]!.v}`);
  return tree;
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
