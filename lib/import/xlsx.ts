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
 * **Every sheet becomes its own document.** One grid per document is the model here, and quietly
 * importing tab one of four is the kind of silent loss this system is built to avoid.
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * What `fast-xml-parser` hands back: a tree whose shape is the document's, not ours. Named rather
 * than left as `any` so the reads below are visibly against untyped XML.
 */
type Xml = Record<string, unknown>;
const node = (v: unknown): Xml => (typeof v === 'object' && v !== null ? (v as Xml) : {});

import { evaluateSheet } from '../sheet/evaluate.ts';
import { parseFormula } from '../sheet/parse.ts';
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
    const o = v as Record<string, unknown>;
    if ('#text' in o) return String(o['#text']);
    // Rich text: a run per formatting change, which is presentation and not content.
    if ('r' in o) return list(o['r'] as Record<string, unknown>[]).map((run) => textOf(run['t'])).join('');
    if ('t' in o) return textOf(o['t']);
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

function readSheet(xml: string, shared: string[], dates: Set<number>): Omit<ImportedSheet, 'name'> {
  const doc = parser.parse(xml) as Xml;
  const cells: Record<string, string> = {};
  /** What Excel last computed for each formula cell, to check our own arithmetic against. */
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

  // **Check our arithmetic against Excel's own.**
  //
  // A formula is only worth keeping if re-evaluating it here reproduces the number the workbook was
  // showing. Where it does not, the import has quietly changed a figure somebody has been looking
  // at — a reference to a sheet that came in separately, a function this engine reads but reads
  // differently, an argument order that is not what it looked like. The cached value is what the
  // author last saw, so that is what is kept, and the formula is dropped rather than left to
  // disagree in silence.
  const values = evaluateSheet({ cells });
  let formulasKept = 0;
  for (const [ref, was] of Object.entries(cached)) {
    const now = values[ref];
    const agrees =
      typeof now === 'number' &&
      (Math.abs(now - was) <= Math.max(1e-6, Math.abs(was) * 1e-9));
    if (agrees) {
      formulasKept++;
    } else {
      cells[ref] = String(was);
      formulasFlattened++;
    }
  }
  // A formula with no cached value at all — openpyxl writes these — cannot be checked, so it is
  // kept and counted. Nothing was displayed for it to disagree with.
  for (const ref of Object.keys(cells)) {
    if (cells[ref]!.startsWith('=') && !(ref in cached)) formulasKept++;
  }

  return { cells, formulasKept, formulasFlattened };
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

  // The workbook names the sheets and their order; the files are numbered separately, so a
  // workbook whose tabs were reordered would otherwise import under the wrong names.
  const doc = parser.parse(workbookXml) as Xml;
  const named = list(node(node(doc['workbook'])['sheets'])['sheet'] as Xml[]);

  const out: ImportedSheet[] = [];
  named.forEach((s, i) => {
    const xml = zip.get(`xl/worksheets/sheet${i + 1}.xml`)?.toString('utf8');
    if (!xml) return;
    const name = String(s['@name'] ?? `Sheet${i + 1}`);
    out.push({ name, ...readSheet(xml, shared, dates) });
  });

  if (out.length === 0) throw new UnreadableWorkbook('This workbook has no sheets in it.');
  return out;
}
