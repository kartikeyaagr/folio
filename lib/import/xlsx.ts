/**
 * Excel, into a grid this system can hold.
 *
 * An `.xlsx` is a zip of XML: a workbook naming the sheets, a sheet per tab, usually a shared
 * string table, and styles that say which numbers are really dates. `./zip.ts` opens it and
 * `fast-xml-parser` — already here for NSE's XBRL — reads it.
 *
 * **Formulas are kept where this system can evaluate them, and the cached value where it cannot.**
 * That is the whole point of importing rather than pasting: a model whose arithmetic survives is a
 * model that still answers when a figure under it changes. A formula using something the engine
 * does not have (VLOOKUP, a named range, another workbook) would evaluate to `#NAME?` across the
 * sheet, so its last computed value is taken instead and the cell becomes a number — true when it
 * was saved, and honestly inert rather than loudly broken.
 *
 * **The workbook arrives whole, and is checked whole.** Every tab is read first and the arithmetic
 * is only then re-run, once, across all of them together — because `=Inputs!B4` cannot agree with
 * the number Excel cached for it while `Inputs` is still a separate grid nobody can see. Checking
 * tab by tab, which is what this did until a document could hold tabs, marked every cross-sheet
 * formula as disagreeing and replaced it with a constant: the model came in already dead.
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * What `fast-xml-parser` hands back: a tree whose shape is the document's, not ours. Named rather
 * than left as `any` so the reads below are visibly against untyped XML.
 */
type Xml = Record<string, unknown>;
const node = (v: unknown): Xml => (typeof v === 'object' && v !== null ? (v as Xml) : {});

import { cleanName, uniqueName } from '../sheet/book.ts';
import { parseRef, type CellRef } from '../sheet/cells.ts';
import { evaluateWorkbook } from '../sheet/evaluate.ts';
import { parseFormula, type Node } from '../sheet/parse.ts';
import { unzip, UnreadableZip } from './zip.ts';

export class UnreadableWorkbook extends Error {}

export interface ImportedSheet {
  name: string;
  cells: Record<string, string>;
  /** Formulas kept as formulas, and formulas replaced by their last value. Reported, not hidden. */
  formulasKept: number;
  formulasFlattened: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // A cell holding "0" or "TRUE" must stay text until we decide what it is; letting the XML reader
  // guess types first would lose the distinction between a number and a string that looks like one.
  parseTagValue: false,
  parseAttributeValue: false,
  // Rich text is one run per formatting change, and the spaces between them live at the edges of
  // those runs. Trimming turns "Rich text" into "Richtext".
  trimValues: false,
});

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const record = v as Record<string, unknown>;
    if ('#text' in record) return String(record['#text']);
    // Rich text: a run per formatting change, which is presentation and not content.
    if ('r' in record) return list(record['r'] as Record<string, unknown>[]).map((run) => textOf(run['t'])).join('');
    if ('t' in record) return textOf(record['t']);
    return '';
  }
  return String(v);
};

/**
 * Which style indexes mean "this number is a date".
 *
 * Excel stores a date as a count of days and a format that says to show it as one, so the number
 * alone cannot tell you: 46112 is either the 31st of March 2026 or the number 46112, and only the
 * style says which. The built-in date formats are 14-22 and 45-47; anything custom is judged by
 * whether its pattern contains a day, month or year token outside a quoted literal.
 */
function dateStyles(stylesXml: string | null): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const doc = parser.parse(stylesXml) as Xml;
  const styles = node(doc['styleSheet']);

  const dateFormats = new Set<number>([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  for (const f of list(node(styles['numFmts'])['numFmt'] as Xml[])) {
    const id = Number(f['@numFmtId']);
    const code = String(f['@formatCode'] ?? '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (Number.isFinite(id) && /[ymdhs]/i.test(code)) dateFormats.add(id);
  }
  list(node(styles['cellXfs'])['xf'] as Xml[]).forEach((xf, i) => {
    if (dateFormats.has(Number(xf['@numFmtId']))) out.add(i);
  });
  return out;
}

/**
 * Excel's day zero is the 30th of December 1899.
 *
 * Not the 31st, and not the 1st of January 1900. Lotus 1-2-3 treated 1900 as a leap year, Excel
 * copied the bug for compatibility, and the epoch is shifted to make the arithmetic come out. Every
 * date in every spreadsheet in the world rests on a forty-year-old bug being preserved on purpose.
 */
const EPOCH = Date.UTC(1899, 11, 30);

function serialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 400_000) return null;
  const d = new Date(EPOCH + Math.round(serial) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Shared strings, by index. Real Excel uses these where openpyxl writes them inline. */
function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const doc = parser.parse(xml) as Xml;
  return list(node(doc['sst'])['si'] as unknown[]).map(textOf);
}

/** A tab as it comes off the XML, before its arithmetic has been checked against Excel's. */
interface ParsedSheet {
  cells: Record<string, string>;
  /** What Excel last computed for each formula cell, to check our own arithmetic against. */
  cached: Record<string, number>;
  formulasFlattened: number;
}

function readSheet(xml: string, shared: string[], dates: Set<number>): ParsedSheet {
  const doc = parser.parse(xml) as Xml;
  const cells: Record<string, string> = {};
  const cached: Record<string, number> = {};
  let formulasFlattened = 0;

  for (const row of list(node(node(doc['worksheet'])['sheetData'])['row'] as Xml[])) {
    for (const c of list(row['c'] as Xml[])) {
      const ref = String(c['@r'] ?? '');
      if (!ref) continue;
      const type = String(c['@t'] ?? 'n');
      const raw = c['v'];
      const styleIndex = c['@s'] === undefined ? -1 : Number(c['@s']);

      const formula = c['f'] === undefined ? '' : textOf(c['f']).trim();
      if (formula) {
        // Kept only if this engine can read it, or the whole sheet fills with #NAME?.
        let readable = false;
        try {
          parseFormula(`=${formula}`);
          readable = true;
        } catch {
          readable = false;
        }
        if (readable) {
          cells[ref] = `=${formula}`;
          const wasNumber = Number(textOf(raw));
          if (textOf(raw).trim() !== '' && Number.isFinite(wasNumber)) cached[ref] = wasNumber;
          continue;
        }
        formulasFlattened++;
        // Fall through and take the cached value instead.
      }

      let value: string;
      if (type === 's') value = shared[Number(textOf(raw))] ?? '';
      else if (type === 'inlineStr') value = textOf(c['is']);
      else if (type === 'str') value = textOf(raw);
      else if (type === 'b') value = textOf(raw) === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = textOf(raw); // An error Excel already had; kept as its text.
      else {
        const n = textOf(raw);
        const asDate = dates.has(styleIndex) ? serialToDate(Number(n)) : null;
        value = asDate ?? n;
      }
      if (value !== '') cells[ref] = value;
    }
  }

  return { cells, cached, formulasFlattened };
}

/** A cached formula whose answer here is not the one Excel wrote: which tab, and where on it. */
interface Disagreement {
  sheet: number;
  ref: string;
  was: number;
  col: number;
  row: number;
}

/** Excel's number and ours, to within the slack of having recomputed it in a different engine. */
const agrees = (now: unknown, was: number): boolean =>
  typeof now === 'number' && Math.abs(now - was) <= Math.max(1e-6, Math.abs(was) * 1e-9);

/** Which tab a reference means, by `evaluateWorkbook`'s own rule: trimmed, folded, first wins. */
function tabFinder(names: string[]): (named: string | undefined, here: number) => number | null {
  const byName = new Map<string, number>();
  names.forEach((n, i) => {
    const key = n.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, i);
  });
  return (named, here) => (named === undefined ? here : byName.get(named.trim().toLowerCase()) ?? null);
}

/**
 * Does this formula read any of `watch`?
 *
 * A range is answered by containment rather than by expanding it, for the reason `evaluateWorkbook`
 * asks `rangeSize` before expanding one: a range is bounded only by what somebody typed, and
 * `=SUM(A1:ZZZ9999999)` is a well-formed thing to have typed.
 */
function readsAny(
  formula: string,
  here: number,
  watch: Disagreement[],
  tab: (named: string | undefined, here: number) => number | null,
): boolean {
  const hit = (si: number | null, a: CellRef, b: CellRef): boolean =>
    watch.some(
      (w) =>
        w.sheet === si &&
        w.col >= Math.min(a.col, b.col) && w.col <= Math.max(a.col, b.col) &&
        w.row >= Math.min(a.row, b.row) && w.row <= Math.max(a.row, b.row),
    );
  const walk = (n: Node): boolean => {
    switch (n.t) {
      case 'ref': return hit(tab(n.sheet, here), n.ref, n.ref);
      case 'range': return hit(tab(n.sheet, here), n.from, n.to);
      case 'op': return walk(n.a) || walk(n.b);
      case 'neg': return walk(n.a);
      case 'call': return n.args.some(walk);
      default: return false;
    }
  };
  // Cannot throw: a ref only reaches `cached` if `readSheet` already parsed the same text.
  return walk(parseFormula(formula));
}

/**
 * How many times the workbook is re-checked before the remainder is settled in one go.
 *
 * Every pass turns at least one formula into a constant and never the other way, so the loop ends
 * on its own whatever this is set to — what it bounds is cost, not termination. Sixteen is where
 * it stops being careful about the order: a workbook still moving after sixteen has a chain of
 * sixteen formulas Excel and this engine both disagree about, which no model here is, and
 * evaluating every tab that many times on an upload is already generous.
 */
const MAX_AGREEMENT_PASSES = 16;

/**
 * **Check our arithmetic against Excel's own**, across the whole workbook, until it settles.
 *
 * A formula is only worth keeping if re-evaluating it here reproduces the number the workbook was
 * showing. Where it does not, the import has quietly changed a figure somebody has been looking
 * at — a function this engine reads but reads differently, an argument order that is not what it
 * looked like. The cached value is what the author last saw, so that is what is kept, and the
 * formula is dropped rather than left to disagree in silence.
 *
 * Mutates the parsed grids in place, which is why it is one function and not a fold: a formula
 * that disagrees becomes a constant, and the tab that reads *that* cell must see the constant.
 *
 * **And must see it before it is judged.** One pass compared every formula against the grid as it
 * stood *before* any substitution, so a cell reading a cell that was about to change was judged
 * against a number nobody would ever see again — wrong in both directions, and both were live.
 * `=Inputs!B1*2`, sitting over a B1 that was about to be replaced, was dropped for disagreeing
 * when it agrees exactly with the replacement — freezing a model one cell further down than it
 * had to, on a tab that was not the problem; and `=B1*0.5`, which agreed only because B1 was
 * still evaluating to 0, was kept and then computed 500 where the author had been looking at 0.
 *
 * So it iterates, and each pass settles only the disagreements that are nobody else's — the ones
 * reading no other cell in the list — leaving the rest to be judged again against whatever
 * replaced their input. It terminates on monotonicity rather than on the cap: every pass turns at
 * least one formula into a constant and never turns one back.
 */
function checkAgainstExcel(named: { name: string; parsed: ParsedSheet }[]): ImportedSheet[] {
  const sheets = named.map(({ name, parsed }) => ({ name, cells: parsed.cells }));
  const flattened = named.map(({ parsed }) => parsed.formulasFlattened);
  const tab = tabFinder(sheets.map((s) => s.name));

  for (let pass = 1; ; pass++) {
    const values = evaluateWorkbook({ sheets });
    const wrong: Disagreement[] = [];
    named.forEach(({ parsed }, i) => {
      for (const [ref, was] of Object.entries(parsed.cached)) {
        const at = parseRef(ref);
        // Anything already settled is a constant now, and a constant equals its own cached value.
        if (at === null || !sheets[i]!.cells[ref]!.startsWith('=')) continue;
        if (!agrees(values[i]![ref], was)) {
          wrong.push({ sheet: i, ref, was, col: at.col, row: at.row });
        }
      }
    });
    if (wrong.length === 0) break;

    // Where every disagreement reads another — a ring of them, or the pass the ceiling stops at —
    // none is settled first, so they all are. A formula known to disagree with what the author was
    // looking at must never survive the import, whatever else is unresolved around it.
    const others = (w: Disagreement): Disagreement[] => wrong.filter((o) => o !== w);
    const roots = pass < MAX_AGREEMENT_PASSES
      ? wrong.filter((w) => !readsAny(sheets[w.sheet]!.cells[w.ref]!, w.sheet, others(w), tab))
      : [];
    for (const w of roots.length > 0 ? roots : wrong) {
      sheets[w.sheet]!.cells[w.ref] = String(w.was);
      flattened[w.sheet] = flattened[w.sheet]! + 1;
    }
  }

  return sheets.map(({ name, cells }, i) => ({
    name,
    cells,
    // Whatever is still a formula reproduced what Excel showed for it — or Excel showed nothing
    // for it at all, which is what openpyxl writes and what nothing can check.
    formulasKept: Object.keys(cells).filter((ref) => cells[ref]!.startsWith('=')).length,
    formulasFlattened: flattened[i]!,
  }));
}

/**
 * Which file in the zip holds which tab.
 *
 * `xl/workbook.xml` lists the tabs in the order they appear, and points at each one by relationship
 * id; `xl/_rels/workbook.xml.rels` turns that id into a path. The file numbers are assigned
 * independently, so a workbook whose tabs were ever reordered has `sheet2.xml` first — and taking
 * them positionally attaches the wrong name to the wrong grid. That was survivable while a name
 * was only a title. It is not survivable now that `=Inputs!B4` resolves *by* name: every
 * cross-sheet formula in the workbook would quietly read the wrong tab's numbers.
 *
 * Falls back to position where there is no rels part at all, which is how a hand-written or
 * minimal workbook arrives.
 */
function sheetPaths(zip: Map<string, Buffer>, sheets: Xml[]): (string | null)[] {
  const rels = new Map<string, string>();
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (relsXml) {
    const doc = parser.parse(relsXml) as Xml;
    for (const r of list(node(doc['Relationships'])['Relationship'] as Xml[])) {
      const id = String(r['@Id'] ?? '');
      // Absolute (`/xl/worksheets/…`) and relative (`worksheets/…`) are both written in the wild.
      const target = String(r['@Target'] ?? '').replace(/^\//, '');
      if (id) rels.set(id, target.startsWith('xl/') ? target : `xl/${target}`);
    }
  }

  return sheets.map((s, i) => {
    const byRel = rels.get(String(s['@r:id'] ?? ''));
    if (byRel && zip.has(byRel)) return byRel;
    const byPosition = `xl/worksheets/sheet${i + 1}.xml`;
    return zip.has(byPosition) ? byPosition : null;
  });
}

/** Every sheet in a workbook, in the order the workbook lists them. */
export function readWorkbook(buf: Buffer): ImportedSheet[] {
  let zip: Map<string, Buffer>;
  try {
    zip = unzip(buf);
  } catch (err) {
    throw new UnreadableWorkbook(
      err instanceof UnreadableZip ? `This is not a readable .xlsx: ${err.message}` : String(err),
    );
  }

  const workbookXml = zip.get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) throw new UnreadableWorkbook('No xl/workbook.xml — this is not a spreadsheet.');

  const shared = sharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? null);
  const dates = dateStyles(zip.get('xl/styles.xml')?.toString('utf8') ?? null);

  // The workbook names the tabs and fixes their order; `sheetPaths` says which file each one is.
  const doc = parser.parse(workbookXml) as Xml;
  const named = list(node(node(doc['workbook'])['sheets'])['sheet'] as Xml[]);
  const paths = sheetPaths(zip, named);

  const parsed: { name: string; parsed: ParsedSheet }[] = [];
  named.forEach((s, i) => {
    const path = paths[i];
    const xml = path === null || path === undefined ? undefined : zip.get(path)?.toString('utf8');
    if (!xml) return;
    // Named exactly as the workbook names it, within what a reference can address, and never twice:
    // `evaluateWorkbook` resolves a tab by name, so two tabs called the same thing would make
    // `=Model!B4` mean whichever came first.
    const name = uniqueName(cleanName(String(s['@name'] ?? `Sheet${i + 1}`)), parsed.map((p) => p.name));
    parsed.push({ name, parsed: readSheet(xml, shared, dates) });
  });

  if (parsed.length === 0) throw new UnreadableWorkbook('This workbook has no sheets in it.');
  return checkAgainstExcel(parsed);
}
