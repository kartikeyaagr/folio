'use client';

import type { Mark } from '@/lib/prose/marks.ts';

/**
 * The formatting toolbar for prose.
 *
 * The same row as the spreadsheet's, for the same reason and in the same shape — one line, grouped
 * by what the control does. What it writes is markdown, so the thing being formatted stays the
 * thing that was stored: the argument in `lib/prose/parse.ts`.
 *
 * **Read is a control, not a mode you can get lost in.** Markdown's honest cost is that `**bold**`
 * reads as asterisks while you type it, so there has to be somewhere the formatting is actually
 * visible. A toggle is the version of that which does not need a second pane, a scroll-sync, or an
 * answer to "which half has the keyboard".
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
const READ = icon(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);

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
];

export function DocToolbar({
  words,
  reading,
  disabled,
  onMark,
  onToggleRead,
}: {
  words: number;
  reading: boolean;
  disabled: boolean;
  onMark: (mark: Mark) => void;
  onToggleRead: () => void;
}) {
  return (
    <div className="sheet-tools" role="toolbar" aria-label="Formatting">
      <span className="sheet-tools-ref">{words} {words === 1 ? 'word' : 'words'}</span>

      {GROUPS.map((group, i) => (
        <span className="sheet-tools-group" key={i}>
          {group.map((b) => (
            <button
              key={b.mark}
              type="button"
              className="sheet-tool"
              // Marks act on the text, and in Read there is no text to act on.
              disabled={disabled || reading}
              title={b.title}
              onClick={() => onMark(b.mark)}
            >
              {b.label}
            </button>
          ))}
        </span>
      ))}

      <span className="sheet-tools-group">
        <button
          type="button"
          className="sheet-tool"
          aria-pressed={reading}
          title={reading ? 'Back to writing' : 'Read it as it will be read'}
          onClick={onToggleRead}
        >
          {READ}
        </button>
      </span>
    </div>
  );
}
