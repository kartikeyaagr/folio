/**
 * Word, into text.
 *
 * A `.docx` is a zip whose `word/document.xml` holds the body: paragraphs of runs of text, plus
 * tables. Everything else in the archive is presentation — fonts, styles, numbering, theme — and
 * this system stores prose, not typography.
 *
 * **What is kept is structure that carries meaning.** A paragraph break is a paragraph break, a
 * list item is a line beginning with a dash, and a table is its rows tab-separated — because a
 * table flattened into a run-on sentence loses which number belonged to which year, and that is
 * the one thing a note about a company cannot afford to lose.
 */

import { XMLParser } from 'fast-xml-parser';

import { unzip, UnreadableZip } from './zip.ts';

/**
 * What `fast-xml-parser` hands back: a tree whose shape is the document's, not ours. Named rather
 * than left as `any` so the reads below are visibly against untyped XML.
 */
type Xml = Record<string, unknown>;
const node = (v: unknown): Xml => (typeof v === 'object' && v !== null ? (v as Xml) : {});

export class UnreadableDocument extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  // A run ends where the next begins, and the space between two words often sits at the edge of
  // one of them. Trimming runs glues words together.
  trimValues: false,
});

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The text of one run, including the tab and break elements Word stores separately. */
function runText(run: Record<string, unknown>): string {
  let out = '';
  for (const [key, value] of Object.entries(run)) {
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (local === 't') {
      for (const t of list(value as unknown[])) {
        out += typeof t === 'object' && t !== null ? String((t as Record<string, unknown>)['#text'] ?? '') : String(t ?? '');
      }
    } else if (local === 'tab') out += '\t';
    else if (local === 'br' || local === 'cr') out += '\n';
  }
  return out;
}

const paragraphText = (p: Record<string, unknown>): string =>
  list(p['w:r'] as Record<string, unknown>[]).map(runText).join('');

/** A heading or a list, judged from the paragraph's style rather than from how it looks. */
function prefixFor(p: Record<string, unknown>): string {
  const props = p['w:pPr'] as Record<string, unknown> | undefined;
  const style = String(
    (props?.['w:pStyle'] as Record<string, unknown> | undefined)?.['@w:val'] ?? '',
  );
  if (/^Heading(\d)/.test(style)) return '#'.repeat(Math.min(6, Number(/^Heading(\d)/.exec(style)![1]))) + ' ';
  if (/List(Bullet|Paragraph)/i.test(style) || props?.['w:numPr'] !== undefined) return '- ';
  return '';
}

function tableText(tbl: Record<string, unknown>): string {
  const rows: string[] = [];
  for (const tr of list(tbl['w:tr'] as Record<string, unknown>[])) {
    const cells = list(tr['w:tc'] as Record<string, unknown>[]).map((tc) =>
      list(tc['w:p'] as Record<string, unknown>[]).map(paragraphText).join(' ').trim(),
    );
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

export function readDocx(buf: Buffer): string {
  let zip: Map<string, Buffer>;
  try {
    zip = unzip(buf);
  } catch (err) {
    throw new UnreadableDocument(
      err instanceof UnreadableZip ? `This is not a readable .docx: ${err.message}` : String(err),
    );
  }

  const xml = zip.get('word/document.xml')?.toString('utf8');
  if (!xml) throw new UnreadableDocument('No word/document.xml — this is not a Word document.');

  const doc = parser.parse(xml) as Xml;
  const body = node(node(doc['w:document'])['w:body']);
  if (Object.keys(body).length === 0) throw new UnreadableDocument('This document has no body.');

  // The body's children in document order. `fast-xml-parser` groups by tag name, so paragraphs and
  // tables arrive as two lists and their interleaving is lost — which matters for a note whose
  // table sits between two paragraphs. `preserveOrder` would keep it at the cost of a much more
  // awkward shape; for prose with a table or two at the end, paragraphs then tables reads correctly
  // and is the trade taken here, stated rather than hidden.
  const parts: string[] = [];
  for (const p of list(body['w:p'] as Xml[])) {
    const text = paragraphText(p);
    parts.push(text.trim() === '' ? '' : prefixFor(p) + text);
  }
  for (const tbl of list(body['w:tbl'] as Xml[])) {
    const t = tableText(tbl);
    if (t.trim() !== '') parts.push('', t);
  }

  // Runs of blank paragraphs collapse to one: Word documents are full of empty paragraphs used as
  // spacing, and they are formatting rather than content.
  const text = parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // A document that produced nothing is not a document that said nothing. An image-only `.docx` —
  // a scan dropped into Word, which is how a physical document reaches this desk — has a body
  // full of `w:drawing` and not one `w:t`, and returning '' for it put a blank note on the record
  // under a real title, where the emptiness reads as the author's rather than as the reader's.
  // The same refusal `pdfToText` makes one file over for a PDF with no text layer.
  if (text === '') {
    throw new UnreadableDocument(
      'This document has no text in it — it is probably a scan, and would import as a blank note.',
    );
  }
  return text;
}
