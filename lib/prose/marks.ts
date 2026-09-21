/**
 * What each toolbar button does to the text.
 *
 * Pure, and separate from the component, so "what does Bold do to this selection" is a question
 * with a test rather than a question you answer by clicking. The editor supplies the text and the
 * two selection offsets and gets back the new text and where the selection should land — which is
 * the part that decides whether the toolbar feels right: press Bold with nothing selected and the
 * caret has to end up *between* the asterisks, ready to type.
 *
 * **Every mark toggles.** Pressing Bold on text that is already bold takes the asterisks off. A
 * toolbar where the button only ever adds is one you end up undoing by hand, and the state it
 * produces — `****bold****` — is not even wrong in a way markdown will tell you about.
 */

export type Mark =
  | 'bold' | 'italic' | 'strike' | 'code'
  | 'h1' | 'h2' | 'h3'
  | 'bullet' | 'number' | 'quote'
  | 'link' | 'rule'
  // Not marks on the text but actions on the editor, handled by `RichEditor` rather than here.
  // They are in this union so the toolbar has one vocabulary instead of two.
  | 'undo' | 'redo' | 'clear';

export interface Edit {
  text: string;
  start: number;
  end: number;
}

/** The delimiter each wrapping mark uses. */
const WRAP: Partial<Record<Mark, string>> = {
  bold: '**', italic: '*', strike: '~~', code: '`',
};

/** The line prefix each block mark uses. */
const PREFIX: Partial<Record<Mark, string>> = {
  h1: '# ', h2: '## ', h3: '### ', bullet: '- ', quote: '> ',
};

/** Any prefix this toolbar applies, so switching from a heading to a bullet replaces rather than stacks. */
const ANY_PREFIX = /^(\s*)(#{1,6}\s+|[-*]\s+|\d+[.)]\s+|>\s?)/;

/**
 * Apply a mark to `text` between `start` and `end`.
 *
 * Returns the whole document rather than a patch, because a textarea's value is set whole anyway
 * and a patch would need the caller to do the same arithmetic this already did.
 */
export function applyMark(text: string, start: number, end: number, mark: Mark): Edit {
  // Editor actions, not text transforms — a caller working on a plain string has nothing to do.
  if (mark === 'undo' || mark === 'redo' || mark === 'clear') return { text, start, end };
  if (mark === 'rule') return insertRule(text, start, end);
  if (mark === 'link') return insertLink(text, start, end);
  const wrap = WRAP[mark];
  if (wrap !== undefined) return toggleWrap(text, start, end, wrap);
  return togglePrefix(text, start, end, mark);
}

function toggleWrap(text: string, start: number, end: number, wrap: string): Edit {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  // Already wrapped, with the delimiters inside the selection: `**bold**` selected whole.
  if (selected.length >= wrap.length * 2 && selected.startsWith(wrap) && selected.endsWith(wrap)) {
    const inner = selected.slice(wrap.length, -wrap.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  // Already wrapped, with the delimiters outside it: `bold` selected between the asterisks.
  if (before.endsWith(wrap) && after.startsWith(wrap)) {
    return {
      text: before.slice(0, -wrap.length) + selected + after.slice(wrap.length),
      start: start - wrap.length,
      end: end - wrap.length,
    };
  }
  return {
    text: `${before}${wrap}${selected}${wrap}${after}`,
    // With nothing selected the caret lands between the delimiters, ready to type into them.
    start: start + wrap.length,
    end: end + wrap.length,
  };
}

/**
 * The lines a selection touches, even where it starts and ends mid-line.
 *
 * The `end - 1` is the whole subtlety. A triple-click and a shift+Down both leave the caret at
 * the *start* of the line after the one selected, so searching for the next break from `end`
 * found the break below that — and marking one paragraph as a quote marked two. Backing up one
 * character keeps a selection that ends on a line break inside the line it came from. An empty
 * selection must not back up, or a caret sitting at the start of a line would take the line
 * above instead.
 */
function lineSpan(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = text.indexOf('\n', end > start ? end - 1 : end);
  return { from, to: nextBreak === -1 ? text.length : nextBreak };
}

function togglePrefix(text: string, start: number, end: number, mark: Mark): Edit {
  const { from, to } = lineSpan(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const numbered = mark === 'number';
  const prefix = PREFIX[mark];
  if (!numbered && prefix === undefined) return { text, start, end };

  const wanted = (i: number): string => (numbered ? `${i + 1}. ` : prefix!);
  // Off only when every line already carries it — a mixed selection turns all of them on, which is
  // what a person pressing the button on a mixed selection meant. Indexed by position, not by
  // `indexOf`: two identical lines in a list are common and would both resolve to the first.
  //
  // **A numbered line counts whatever its number is.** This compared each line against
  // `${i + 1}. ` counted from the start of the *selection*, so selecting the second and third
  // items of a list measured "2. " against a wanted "1. ", decided the list was not a list, and
  // renumbered it instead of clearing it. Pressing the button on a numbered list has to turn it
  // off wherever in the list you happen to be standing.
  const carried = (line: string): string | undefined => ANY_PREFIX.exec(line)?.[2];
  const allHave = numbered
    ? lines.every((line) => /^\d+[.)]\s+$/.test(carried(line) ?? ''))
    : lines.every((line, i) => carried(line) === wanted(i));

  const next = lines.map((line, i) => {
    const bare = line.replace(ANY_PREFIX, '$1');
    return allHave ? bare : bare.replace(/^(\s*)/, `$1${wanted(i)}`);
  });

  const replaced = next.join('\n');
  const shift = replaced.length - (to - from);
  return {
    text: text.slice(0, from) + replaced + text.slice(to),
    start: from,
    end: end + shift,
  };
}

function insertLink(text: string, start: number, end: number): Edit {
  const selected = text.slice(start, end);
  const label = selected === '' ? 'text' : selected;
  const body = `[${label}](url)`;
  return {
    text: text.slice(0, start) + body + text.slice(end),
    // Selects `url`, because that is the part you have to fill in either way.
    start: start + label.length + 3,
    end: start + label.length + 6,
  };
}

function insertRule(text: string, start: number, end: number): Edit {
  const before = text.slice(0, start);
  // Its own line, with a blank line around it, or the dashes read as part of the paragraph above.
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const body = `${lead}---\n\n`;
  return {
    text: before + body + text.slice(end),
    start: start + body.length,
    end: start + body.length,
  };
}
