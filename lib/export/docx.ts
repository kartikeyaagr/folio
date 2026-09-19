/**
 * A document, as a `.docx` somebody can open in Word.
 *
 * The other direction from `lib/import/docx.ts`, and it goes through the same tree: the document's
 * text is parsed by `lib/prose/parse.ts` and each block becomes a Word paragraph. So what is
 * exported is what the Read view shows, by construction rather than by two renderers agreeing.
 *
 * **Word is strict about parts it is not given.** `w:pStyle` naming a style that `styles.xml` does
 * not define is ignored silently, so a heading exports as body text; a `w:numPr` with no
 * `numbering.xml` behind it does the same to a list. Both parts are therefore written out rather
 * than skipped, which is most of the length here — the mapping itself is twenty lines.
 */

import { blocks, type Block, type Inline } from '../prose/parse.ts';
import { DEFAULT_FACE, DEFAULT_SIZE, FACES, type Typography } from '../prose/typography.ts';
import { zip, type Entry } from './zip.ts';

/** The five characters XML cannot carry raw. A memo is full of `&` and `<`. */
const xml = (s: string): string =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** How a run is marked, gathered on the way down the inline tree. */
interface Marks {
  b?: true;
  i?: true;
  strike?: true;
  code?: true;
  link?: string;
}

/**
 * One run of text with its marks.
 *
 * Word has no nesting inside a run: bold-inside-italic is one run carrying both, not a run inside a
 * run. So the inline tree is flattened on the way out, carrying the marks down.
 */
function runs(nodes: Inline[], marks: Marks = {}): string {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return run(n.v, marks);
      case 'code': return run(n.v, { ...marks, code: true });
      case 'strong': return runs(n.kids, { ...marks, b: true });
      case 'em': return runs(n.kids, { ...marks, i: true });
      case 'del': return runs(n.kids, { ...marks, strike: true });
      // A link is styled as one and carries its URL in the text, because a real `w:hyperlink` needs
      // a relationship per link in `document.xml.rels` — and a memo's reader wants the address
      // anyway, since this is a document that will be printed and mailed as often as clicked.
      case 'link': return runs(n.kids, { ...marks, link: n.href });
    }
  }).join('');
}

function run(text: string, marks: Marks): string {
  const props: string[] = [];
  if (marks.b) props.push('<w:b/>');
  if (marks.i) props.push('<w:i/>');
  if (marks.strike) props.push('<w:strike/>');
  if (marks.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  if (marks.link) props.push('<w:color w:val="0F2440"/><w:u w:val="single"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // `xml:space="preserve"` or Word drops the spaces between runs, which is every space beside a
  // bold word.
  const body = `${rPr}<w:t xml:space="preserve">${xml(text)}</w:t>`;
  return marks.link ? `<w:r>${body}</w:r>${run(` <${marks.link}>`, { ...marks, link: undefined })}`
    : `<w:r>${body}</w:r>`;
}

const para = (content: string, style?: string, num?: { id: number; from?: number }): string => {
  const props: string[] = [];
  if (style) props.push(`<w:pStyle w:val="${style}"/>`);
  if (num) props.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num.id}"/></w:numPr>`);
  const pPr = props.length > 0 ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${content}</w:p>`;
};

function paragraphs(block: Block): string {
  switch (block.t) {
    case 'p': return para(runs(block.kids));
    case 'h': return para(runs(block.kids), `Heading${Math.min(block.level, 3)}`);
    case 'ul': return block.items.map((i) => para(runs(i), 'ListParagraph', { id: 1 })).join('');
    case 'ol': return block.items.map((i) => para(runs(i), 'ListParagraph', { id: 2 })).join('');
    case 'quote': return block.lines.map((l) => para(runs(l), 'Quote')).join('');
    // A rule is a paragraph with a border under it, which is how Word itself stores one.
    case 'hr':
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8CEDA"/>'
        + '</w:pBdr></w:pPr></w:p>';
  }
}

/**
 * The document's own face and size, as Word states them.
 *
 * `w:sz` is in half-points, so an 11pt document is `22`. The face is a name from `FACES` rather
 * than the CSS stack the screen uses: a memo exported in a family Word cannot find arrives in
 * Calibri, and the reader never learns that it was meant to be anything else.
 */
const defaults = (t: Typography): string => {
  const word = FACES.find((f) => f.value === t.face)?.word ?? 'Georgia';
  return `<w:docDefaults><w:rPrDefault><w:rPr>`
    + `<w:rFonts w:ascii="${word}" w:hAnsi="${word}"/><w:sz w:val="${t.size * 2}"/>`
    + `</w:rPr></w:rPrDefault></w:docDefaults>`;
};

const STYLE = (id: string, name: string, rPr: string, spacing = ''): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>`
  + `<w:pPr>${spacing}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const styles = (t: Typography): string => `${DECL}
<w:styles xmlns:w="${W}">
${defaults(t)}
${STYLE('Heading1', 'heading 1', '<w:b/><w:sz w:val="34"/>', '<w:spacing w:before="320" w:after="140"/>')}
${STYLE('Heading2', 'heading 2', '<w:b/><w:sz w:val="28"/>', '<w:spacing w:before="280" w:after="120"/>')}
${STYLE('Heading3', 'heading 3', '<w:b/><w:sz w:val="24"/>', '<w:spacing w:before="240" w:after="100"/>')}
${STYLE('Quote', 'Quote', '<w:i/><w:color w:val="3B475C"/>', '<w:ind w:left="480"/>')}
${STYLE('ListParagraph', 'List Paragraph', '', '<w:ind w:left="720"/>')}
</w:styles>`;

/**
 * Two lists: bullets and numbers.
 *
 * `numId` 1 and 2 are what `paragraphs` above references. The indents match `ListParagraph`'s, so a
 * list item lines up with itself whether Word reads the style or the numbering first.
 */
const NUMBERING = `${DECL}
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">
<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/>
<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>
</w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0">
<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>
<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
</w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const ROOT_RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>
</Relationships>`;

/**
 * A document's title and text as `.docx` bytes.
 *
 * The title leads as a Heading1 rather than being left to the filename: a memo mailed to somebody
 * outside this system arrives as a file, and a file whose first line is "The question is not
 * whether the product works" has lost the one line saying what it is about.
 */
export function toDocx(
  title: string,
  text: string,
  type: Typography = { face: DEFAULT_FACE, size: DEFAULT_SIZE },
): Buffer {
  const body = [
    para(runs([{ t: 'text', v: title }]), 'Heading1'),
    ...blocks(text).map(paragraphs),
  ].join('');

  const document = `${DECL}
<w:document xmlns:w="${W}"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/></w:sectPr>
</w:body></w:document>`;

  const entries: Entry[] = [
    { name: '[Content_Types].xml', body: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', body: Buffer.from(document, 'utf8') },
    { name: 'word/_rels/document.xml.rels', body: Buffer.from(DOC_RELS, 'utf8') },
    { name: 'word/styles.xml', body: Buffer.from(styles(type), 'utf8') },
    { name: 'word/numbering.xml', body: Buffer.from(NUMBERING, 'utf8') },
  ];
  return zip(entries);
}

/** A filename a person can find again, out of a title that may hold anything. */
export function docxFilename(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean === '' ? 'document' : clean}.docx`;
}
