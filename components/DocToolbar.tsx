'use client';

import type { Mark } from '@/lib/prose/marks.ts';
import { FACES, SIZES, type Face, type Typography } from '@/lib/prose/typography.ts';

/**
 * The formatting toolbar for prose.
 *
 * The same row as the spreadsheet's, for the same reason and in the same shape — one line, grouped
 * by what the control does. What it writes is markdown, so the thing being formatted stays the
 * thing that was stored: the argument in `lib/prose/parse.ts`.
 *
 * There is no preview toggle, because there is nothing to preview: `components/RichEditor.tsx`
 * shows the document itself, and these buttons act on the selection in it. What they are named
 * after is still markdown — that is what gets stored — but the names are in the tooltips and the
 * asterisks are nowhere on the screen.
 */

const icon = (path: React.ReactNode) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const BULLET = icon(<><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.2" /><circle cx="4.5" cy="12" r="1.2" /><circle cx="4.5" cy="18" r="1.2" /></>);
const NUMBER = icon(<><path d="M10 6h10M10 12h10M10 18h10" /><path d="M4 4.5h1.5V9" /><path d="M3.5 13.2a1.3 1.3 0 1 1 2.2 1L3.5 17h2.5" /></>);
const QUOTE = icon(<><path d="M7 7v10" /><path d="M11 9h8M11 13h6" /></>);
const LINK = icon(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>);
const RULE = icon(<path d="M4 12h16" />);
const CODE = icon(<><path d="m9 17-5-5 5-5" /><path d="m15 7 5 5-5 5" /></>);
const UNDO = icon(<><path d="M3 7v6h6" /><path d="M3.5 13a9 9 0 1 1 2.1 5.3" /></>);
const REDO = icon(<><path d="M21 7v6h-6" /><path d="M20.5 13a9 9 0 1 0-2.1 5.3" /></>);
const CLEAR = icon(<><path d="M4 7h16" /><path d="M10 7V5h4v2" /><path d="M6 7l1 12h10l1-12" /><path d="M14 11l-4 4M10 11l4 4" /></>);
/** Grouped the way they are pressed: how the words read, then how the lines are shaped, then what is inserted. */
const GROUPS: { mark: Mark; label: React.ReactNode; title: string }[][] = [
  [
    { mark: 'bold', label: <b>B</b>, title: 'Bold  **text**' },
    { mark: 'italic', label: <i>I</i>, title: 'Italic  *text*' },
    { mark: 'strike', label: <s>S</s>, title: 'Strikethrough  ~~text~~' },
    { mark: 'code', label: CODE, title: 'Code  `text`' },
  ],
  [
    { mark: 'h1', label: <span>H1</span>, title: 'Heading  # text' },
    { mark: 'h2', label: <span>H2</span>, title: 'Subheading  ## text' },
    { mark: 'h3', label: <span>H3</span>, title: 'Sub-subheading  ### text' },
  ],
  [
    { mark: 'bullet', label: BULLET, title: 'Bulleted list  - item' },
    { mark: 'number', label: NUMBER, title: 'Numbered list  1. item' },
    { mark: 'quote', label: QUOTE, title: 'Quote  > text' },
  ],
  [
    { mark: 'link', label: LINK, title: 'Link  [text](url)' },
    { mark: 'rule', label: RULE, title: 'Horizontal rule  ---' },
  ],
  [
    { mark: 'clear', label: CLEAR, title: 'Clear formatting from the selection' },
    { mark: 'undo', label: UNDO, title: 'Undo' },
    { mark: 'redo', label: REDO, title: 'Redo' },
  ],
];

export function DocToolbar({
  words,
  disabled,
  type,
  onMark,
  onType,
}: {
  words: number;
  disabled: boolean;
  /** The document's own typeface and size — see `lib/prose/typography.ts` for why it is the
   *  document's rather than the selection's. */
  type: Typography;
  onMark: (mark: Mark) => void;
  onType: (next: Partial<Typography>) => void;
}) {
  return (
    <div className="sheet-tools" role="toolbar" aria-label="Formatting">
      <span className="sheet-tools-ref">{words} {words === 1 ? 'word' : 'words'}</span>

      {/* Set on the document rather than on what is selected. Markdown has nowhere to put "these
          four words are 14pt Georgia", so a per-selection control here would be one that silently
          lost its own effect on save — and nobody sets a memo in three faces anyway. */}
      <span className="sheet-tools-group">
        <label className="sheet-tools-label" title="The typeface this document is set in">
          <span className="sr-only">Typeface</span>
          <select
            className="field sheet-tool-select sheet-tool-face"
            disabled={disabled}
            value={type.face}
            onChange={(e) => onType({ face: e.target.value as Face })}
          >
            {FACES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <label className="sheet-tools-label" title="The size this document is set in">
          <span className="sr-only">Size</span>
          <select
            className="field sheet-tool-select sheet-tool-size"
            disabled={disabled}
            value={type.size}
            onChange={(e) => onType({ size: Number(e.target.value) })}
          >
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </span>

      {GROUPS.map((group, i) => (
        <span className="sheet-tools-group" key={i}>
          {group.map((b) => (
            <button
              key={b.mark}
              type="button"
              className="sheet-tool"
              disabled={disabled}
              title={b.title}
              onClick={() => onMark(b.mark)}
            >
              {b.label}
            </button>
          ))}
        </span>
      ))}
    </div>
  );
}
