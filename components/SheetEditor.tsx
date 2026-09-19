'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { uniqueName, type Tab } from '@/lib/sheet/book.ts';
import { columnName, expandRange, refName, type CellRef } from '@/lib/sheet/cells.ts';
import { evaluateWorkbook, isCellError, type Lookups, type Value } from '@/lib/sheet/evaluate.ts';
import {
  classesFor, clampCol, clampRow, display, isEmpty, stepDp, withPatch,
  type Format, type Formats, type Sizes,
} from '@/lib/sheet/format.ts';
import { renameSheetIn } from '@/lib/sheet/parse.ts';

import { SaveSlot } from './SaveSlot.tsx';
import { SheetTabs } from './SheetTabs.tsx';
import { SheetToolbar } from './SheetToolbar.tsx';

/**
 * The workbook.
 *
 * Evaluated on the client as you type, so a model responds the way a spreadsheet is supposed to —
 * and evaluated **whole**, every tab at once, because `=Inputs!B4` is only answerable if the tab
 * holding the answer is in scope. The **data** functions cannot run here, since they read this
 * box's own figures, so they are resolved on the server and handed in as `lookups`, and re-resolved
 * on save when the set of calls has changed.
 *
 * **Selecting and editing are two different things**, which they have to be once there is a
 * formatting toolbar: a click has to be able to mean "this is the cell I want to make bold" rather
 * than "put a cursor in this cell". So a click selects, shift-click extends, and typing or
 * double-clicking or Enter opens the cell. That is the interaction every spreadsheet has, and it is
 * the one this grid lacked — a click used to go straight into the editor.
 *
 * A cell shows its **value**, except the one being edited, which shows its formula. Formatting
 * changes only how that value is drawn; `lib/sheet/format.ts` argues why that stays strict.
 */

const COLS = 12;
const ROWS = 40;

/**
 * How wide a column should be, decided by what is in it.
 *
 * One width for every column is the thing that makes a grid need resizing before it can be read: a
 * date column 200px wide next to a line-item column 200px wide wastes half the screen on the first
 * and truncates the second. These buckets are classes rather than measured pixels on purpose — a
 * width computed from the longest string re-flows the whole grid while you are typing into it, and
 * a column that only moves when its *kind* changes stays still while you work.
 */
type ColumnKind = 'num' | 'num-wide' | 'date' | 'short' | 'text' | 'long';

/** What `lib/import/xlsx.ts` writes for an Excel date serial once it has resolved the style. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A plain figure fits in the narrow bucket; `₹2,58,59,40,000` does not. */
const WIDE_NUMBER = 11;
/** A column of codes and flags — `Cons`, `Std`, `Q1` — needs no more room than that. */
const SHORT_TEXT = 10;
/** Past this many characters a text column is holding prose — a line-item name, a note. */
const LONG_TEXT = 28;

/**
 * Measured on what the cell **draws**, not on what it holds.
 *
 * This is the whole interaction between the two features. `2585940000` is ten characters and fits
 * the narrow numeric column; formatted as rupees it is `₹2,58,59,40,000`, which is fifteen and
 * wraps to two lines in the same column. Classifying on the raw value made every currency column
 * in a model twice as tall as it needed to be — so the classifier renders each cell exactly as the
 * grid will and measures that.
 */
function columnKind(values: Record<string, Value>, formats: Formats, col: number): ColumnKind {
  let numbers = 0;
  let dates = 0;
  let texts = 0;
  let longestNumber = 0;
  let longestText = 0;

  for (let row = 0; row < ROWS; row++) {
    const ref = refName({ col, row });
    const v = values[ref];
    if (v === undefined || v === '') continue;
    const f = formats[ref];
    const drawn = display(v, f).length;

    // A boolean and an error are both short and both right-ish: they size like a number.
    if (typeof v === 'number' || typeof v === 'boolean' || isCellError(v)) {
      numbers++;
      longestNumber = Math.max(longestNumber, drawn);
      continue;
    }
    if (ISO_DATE.test(String(v)) || f?.style === 'date') {
      dates++;
      continue;
    }
    texts++;
    longestText = Math.max(longestText, drawn);
  }

  if (dates > numbers && dates >= texts) return 'date';
  // `>=` rather than `>`, so the single text heading above a column of figures does not make the
  // whole column a text column. That shape — one label, forty numbers — is most of a model.
  if (numbers >= texts) return longestNumber > WIDE_NUMBER ? 'num-wide' : 'num';
  if (longestText <= SHORT_TEXT) return 'short';
  return longestText > LONG_TEXT ? 'long' : 'text';
}

/** A printable character typed on a selected cell opens it and becomes its first character. */
const isTypingKey = (e: React.KeyboardEvent): boolean =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

export function SheetEditor({
  id,
  sheets: initial,
  lookups: initialLookups,
  onSave,
  readOnly = false,
}: {
  id: string;
  sheets: Tab[];
  lookups: Lookups;
  /** The server action itself. It answers with the figures the saved workbook now asks for. */
  onSave: (id: string, sheets: Tab[]) => Promise<Lookups>;
  readOnly?: boolean;
}) {
  const [sheets, setSheets] = useState<Tab[]>(initial);
  const [active, setActive] = useState(0);
  const [lookups, setLookups] = useState<Lookups>(initialLookups);
  const [anchor, setAnchor] = useState<CellRef>({ col: 0, row: 0 });
  const [head, setHead] = useState<CellRef>({ col: 0, row: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<'clean' | 'saving' | 'dirty' | 'error'>('clean');
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  /**
   * Set by Escape, read by the blur that Escape itself causes.
   *
   * Escape has to put the keyboard back on the grid, and moving focus blurs the textarea — which
   * fires `onBlur={commit}` while `editing` and `draft` still hold what the closure captured, so
   * the edit Escape was cancelling got written instead. Verified: typing `7` into a cell and
   * pressing Escape left `7` in it. A ref rather than state because the blur happens before any
   * re-render, which is the whole problem.
   */
  const discarding = useRef(false);

  // One pass over every tab. The answers come back parallel to `sheets`, so the grid below indexes
  // by position and never has to care that two tabs could be called the same thing.
  const book = useMemo(() => evaluateWorkbook({ sheets, lookups }), [sheets, lookups]);
  const here = Math.min(active, sheets.length - 1);
  const cells = sheets[here]?.cells ?? {};
  const formats: Formats = sheets[here]?.formats ?? {};
  const cols: Sizes = sheets[here]?.cols ?? {};
  const rows: Sizes = sheets[here]?.rows ?? {};
  const values = book[here] ?? {};

  // Recomputed with the values, so a column that becomes a date column becomes a date column's
  // width. Cheap — twelve columns of forty cells — and it keeps the widths honest as a model grows.
  const widths = useMemo(
    () => Array.from({ length: COLS }, (_, c) => columnKind(values, formats, c)),
    [values, formats],
  );

  const selection = useMemo(() => expandRange(anchor, head), [anchor, head]);
  const selected = useMemo(() => new Set(selection.map(refName)), [selection]);
  const anchorRef = refName(anchor);
  const selectionLabel = selection.length === 1 ? anchorRef : `${anchorRef}:${refName(head)}`;

  useEffect(() => {
    const el = input.current;
    if (!editing || !el) return;
    el.focus();
    // A textarea has no "fit the content" height, so it is measured: set it to nothing, read what
    // the content wants, then take that. Per keystroke, which is what makes it grow as you type.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  /**
   * The workbook with the cell currently being edited applied — computed, not stored.
   *
   * Every action below starts here rather than calling a `commit()` that sets state on its own.
   * `setSheets` takes a value, so two of them in one handler both read the array this render closed
   * over and the second silently discards the first. Deriving the committed workbook first makes
   * each handler a single write. Returns the same array when nothing changed.
   */
  const committed = (): Tab[] => {
    const cur = sheets[here];
    if (!editing || !cur) return sheets;
    const next = { ...cur.cells };
    if (draft.trim() === '') delete next[editing];
    else next[editing] = draft;
    if (next[editing] === cur.cells[editing]) return sheets;
    // Spread, so a tab keeps its formats through an edit. Rebuilding it as `{name, cells}` would
    // drop them, and the loss would only show up after a save.
    return sheets.map((s, i) => (i === here ? { ...s, cells: next } : s));
  };

  const commit = (): void => {
    if (discarding.current) {
      discarding.current = false;
      setEditing(null);
      return;
    }
    const next = committed();
    setEditing(null);
    if (next !== sheets) {
      setSheets(next);
      setSaved('dirty');
    }
  };

  /** Select. Shift keeps the anchor and moves the far corner, as every spreadsheet does. */
  const select = (ref: CellRef, extend = false): void => {
    commit();
    if (!extend) setAnchor(ref);
    setHead(ref);
  };

  const edit = (ref: CellRef, startWith?: string): void => {
    if (readOnly) return;
    const name = refName(ref);
    commit();
    // Cleared defensively: if a blur never arrived to consume the flag, the next edit must not
    // inherit it and silently throw itself away.
    discarding.current = false;
    setAnchor(ref);
    setHead(ref);
    setEditing(name);
    setDraft(startWith ?? cells[name] ?? '');
  };

  /** Move the selection by a step, clamped to the grid this renders. */
  const move = (dCol: number, dRow: number, extend: boolean): void => {
    const from = extend ? head : anchor;
    select(
      {
        col: Math.max(0, Math.min(COLS - 1, from.col + dCol)),
        row: Math.max(0, Math.min(ROWS - 1, from.row + dRow)),
      },
      extend,
    );
  };

  /** Empty every selected cell but keep its formatting — which is what Delete does in Sheets. */
  const clearCells = (): void => {
    if (readOnly) return;
    const base = committed();
    const sheet = base[here];
    if (!sheet) return;
    const next = { ...sheet.cells };
    let removed = 0;
    for (const ref of selected) {
      if (next[ref] !== undefined) {
        delete next[ref];
        removed++;
      }
    }
    if (removed === 0) return;
    setEditing(null);
    setSheets(base.map((s, i) => (i === here ? { ...s, cells: next } : s)));
    setSaved('dirty');
  };

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // The textarea owns its own keys while it is open — arrows move a caret, not a selection.
    if (editing) return;
    const shift = e.shiftKey;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); return move(0, -1, shift);
      case 'ArrowDown': e.preventDefault(); return move(0, 1, shift);
      case 'ArrowLeft': e.preventDefault(); return move(-1, 0, shift);
      case 'ArrowRight': e.preventDefault(); return move(1, 0, shift);
      case 'Tab': e.preventDefault(); return move(shift ? -1 : 1, 0, false);
      case 'Enter': case 'F2': e.preventDefault(); return edit(anchor);
      case 'Backspace': case 'Delete': e.preventDefault(); return clearCells();
      default:
        if (isTypingKey(e)) {
          e.preventDefault();
          edit(anchor, e.key);
        }
    }
  };

  /**
   * Dragging a column edge or a row edge.
   *
   * The live part of the drag writes straight to the DOM — `el.style.setProperty('--w', …)` — and
   * only the *end* of the drag goes into React state. Putting every mousemove through `setSheets`
   * would re-render four hundred and eighty cells per frame to move one border, and it shows: the
   * border lags the cursor. One write to one element per frame does not.
   *
   * Which is also why the size is carried as a custom property rather than as `style={{width}}`.
   * The house rule is that styling lives in classes, and it still does — `app/globals.css` owns the
   * `width: var(--w)` declaration and the min/max around it. What the component supplies here is a
   * measurement, which is data, and there is no class that can express "237px because somebody
   * dragged it there".
   */
  const sizeTarget = (kind: 'col' | 'row', index: number): HTMLElement | null =>
    grid.current?.querySelector<HTMLElement>(
      kind === 'col' ? `colgroup col[data-col="${index}"]` : `tbody tr[data-row="${index}"]`,
    ) ?? null;

  const beginResize = (kind: 'col' | 'row', index: number, e: React.MouseEvent): void => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const el = sizeTarget(kind, index);
    if (!el) return;

    const isCol = kind === 'col';
    const from = isCol ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
    const start = isCol ? e.clientX : e.clientY;
    const clamp = isCol ? clampCol : clampRow;
    let last = clamp(from);

    const onMove = (m: MouseEvent): void => {
      last = clamp(from + ((isCol ? m.clientX : m.clientY) - start));
      el.style.setProperty(isCol ? '--w' : '--h', `${last}px`);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove(isCol ? 'is-col-resizing' : 'is-row-resizing');
      setSize(kind, index, last);
    };

    // On the body, so the cursor stays the resize cursor across the whole drag rather than
    // flickering back to `cell` the moment the pointer leaves the two-pixel handle.
    document.body.classList.add(isCol ? 'is-col-resizing' : 'is-row-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** Write a dragged size into the tab. `null` removes it, putting the column back on automatic. */
  const setSize = (kind: 'col' | 'row', index: number, px: number | null): void => {
    const base = committed();
    const sheet = base[here];
    if (!sheet) return;
    const key = kind === 'col' ? 'cols' : 'rows';
    const next: Sizes = { ...sheet[key] };
    if (px === null) delete next[String(index)];
    else next[String(index)] = px;
    setEditing(null);
    setSheets(base.map((t, i) => (i === here ? { ...t, [key]: next } : t)));
    setSaved('dirty');
  };

  /** Apply a format change across the whole selection. The one writer of `formats`. */
  const applyFormat = (fn: (f: Format | undefined) => Format): void => {
    if (readOnly) return;
    const base = committed();
    const sheet = base[here];
    if (!sheet) return;
    const next: Formats = { ...sheet.formats };
    for (const ref of selected) {
      const f = fn(next[ref]);
      if (isEmpty(f)) delete next[ref];
      else next[ref] = f;
    }
    setEditing(null);
    setSheets(base.map((s, i) => (i === here ? { ...s, formats: next } : s)));
    setSaved('dirty');
    grid.current?.focus();
  };

  const pick = (index: number): void => {
    commit();
    setActive(index);
    setAnchor({ col: 0, row: 0 });
    setHead({ col: 0, row: 0 });
  };

  const addSheet = (): void => {
    const base = committed();
    setEditing(null);
    setSheets([
      ...base,
      {
        name: uniqueName(`Sheet${base.length + 1}`, base.map((s) => s.name)),
        cells: {}, formats: {}, cols: {}, rows: {},
      },
    ]);
    setActive(base.length);
    setSaved('dirty');
    setMessage(null);
  };

  /**
   * Rename a tab, and move every reference that named it.
   *
   * The rewrite is the point. A formula reaches a tab by name, so renaming `Inputs` without
   * touching `=Inputs!B4` turns that cell — and everything downstream of it — into `#REF!`, in
   * cells nobody edited. Excel rewrites them silently; this rewrites them and then says how many.
   */
  const rename = (index: number, wanted: string): void => {
    const base = committed();
    const from = base[index]?.name;
    if (from === undefined) return;
    const to = uniqueName(wanted, base.filter((_, i) => i !== index).map((s) => s.name));
    if (to === from) return;

    let moved = 0;
    const next = base.map((sheet, i) => {
      const cells: Record<string, string> = {};
      for (const [ref, raw] of Object.entries(sheet.cells)) {
        const rewritten = raw.trimStart().startsWith('=')
          ? renameSheetIn(raw.trimStart(), from, to)
          : null;
        if (rewritten !== null) moved++;
        cells[ref] = rewritten ?? raw;
      }
      return { ...sheet, cells, ...(i === index ? { name: to } : {}) };
    });

    setEditing(null);
    setSheets(next);
    setSaved('dirty');
    setMessage(
      moved === 0
        ? `Renamed ${from} to ${to}.`
        : `Renamed ${from} to ${to}; ${moved} ${moved === 1 ? 'formula' : 'formulas'} now point at it by its new name.`,
    );
  };

  /**
   * Remove a tab.
   *
   * What pointed at it becomes `#REF!`, which is correct and is what Excel does — a reference to a
   * tab that is gone has no honest answer. Nothing is lost until Save, and the version before it is
   * kept regardless.
   */
  const removeSheet = (index: number): void => {
    const base = committed();
    if (base.length <= 1) return;
    const gone = base[index]?.name ?? '';
    setEditing(null);
    setSheets(base.filter((_, i) => i !== index));
    setActive(Math.max(0, index - 1));
    setSaved('dirty');
    setMessage(`${gone} is removed from this workbook. Anything that referenced it now reads #REF!.`);
  };

  const save = async (): Promise<void> => {
    // The committed workbook, not the one this render closed over. `commit()` schedules a state
    // update; it does not change `sheets` here.
    const next = committed();
    setEditing(null);
    setSheets(next);
    setSaved('saving');
    try {
      // A workbook that gained a data call since the last save gets its answer here, no reload.
      setLookups(await onSave(id, next));
      setSaved('clean');
      setMessage(null);
    } catch (err) {
      // Said, not swallowed. A model whose save failed silently is a model somebody will close.
      setSaved('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  const anchorValue = values[anchorRef];

  /**
   * The strip you grab. Double-click clears the manual size rather than setting it to whatever the
   * automatic size happened to be — so a column put back on automatic keeps following its content.
   */
  const grip = (kind: 'col' | 'row', index: number, sized: boolean) => (
    <span
      className={`sheet-grip sheet-grip-${kind}${sized ? ' is-set' : ''}`}
      role="separator"
      aria-orientation={kind === 'col' ? 'vertical' : 'horizontal'}
      title={sized ? 'Drag to resize · double-click for automatic' : 'Drag to resize'}
      onMouseDown={(e) => beginResize(kind, index, e)}
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); setSize(kind, index, null); }}
    />
  );

  return (
    <div className="sheet">
      <SheetToolbar
        format={formats[anchorRef]}
        selection={selectionLabel}
        disabled={readOnly}
        onPatch={(patch) => applyFormat((f) => withPatch(f, patch))}
        onStepDp={(by) => applyFormat((f) => stepDp(f, by))}
        onClear={() => applyFormat(() => ({}))}
      />

      <div className="sheet-bar">
        <span className="sheet-ref">{selectionLabel}</span>
        <span className="sheet-detail">
          {isCellError(anchorValue)
            ? `${anchorValue.err} — ${anchorValue.detail}`
            : (cells[anchorRef] ??
              (sheets.length > 1
                ? 'Start with = for a formula, and name a tab to reach it: =Inputs!B4.'
                : 'Start with = for a formula.'))}
        </span>
      </div>

      {/* Up in the ribbon, beside the other things you do to a document. What is left here is the
          address and the formula, which is what a formula bar is in every spreadsheet — Excel and
          Sheets both put a name box and a formula in it and nothing else. */}
      {!readOnly && (
        <SaveSlot>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void save()}
            disabled={saved === 'saving' || saved === 'clean'}
          >
            {saved === 'saving' ? 'Saving…' : saved === 'clean' ? 'Saved' : 'Save'}
          </button>
        </SaveSlot>
      )}
      {message && <p className="alert">{message}</p>}

      {/* Focusable, because the arrow keys have to land somewhere. `tabIndex={-1}` rather than 0:
          it takes focus when a cell is clicked but is not a stop on the way through the page. */}
      <div className="tbl-scroll" ref={grid} tabIndex={-1} onKeyDown={onGridKey}>
        <table className="tbl sheet-grid">
          {/* The widths live here rather than on every cell, which is what `table-layout: fixed`
              wants and what stops one long value in row 30 widening the column above it. */}
          <colgroup>
            <col className="sheet-col-head" />
            {widths.map((kind, c) => (
              <col
                key={c}
                data-col={c}
                className={`sheet-col-${kind}${cols[String(c)] ? ' is-sized' : ''}`}
                {...(cols[String(c)] ? { style: { '--w': `${cols[String(c)]}px` } as React.CSSProperties } : {})}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} className="num">
                  {columnName(c)}
                  {!readOnly && grip('col', c, cols[String(c)] !== undefined)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr
                key={r}
                data-row={r}
                className={rows[String(r)] ? 'is-sized' : undefined}
                {...(rows[String(r)] ? { style: { '--h': `${rows[String(r)]}px` } as React.CSSProperties } : {})}
              >
                <th className="sheet-rownum">
                  {r + 1}
                  {!readOnly && grip('row', r, rows[String(r)] !== undefined)}
                </th>
                {Array.from({ length: COLS }, (_, c) => {
                  const ref = refName({ col: c, row: r });
                  const v = values[ref];
                  const err = isCellError(v) ? v : null;
                  const f = formats[ref];
                  return (
                    <td
                      key={ref}
                      className={[
                        'sheet-cell',
                        err ? 'is-err' : '',
                        // A number is right-aligned unless the format says otherwise.
                        typeof v === 'number' && !f?.align ? 'num' : '',
                        selected.has(ref) ? 'is-picked' : '',
                        ref === anchorRef ? 'is-anchor' : '',
                        editing === ref ? 'is-editing' : '',
                        classesFor(f),
                      ].filter(Boolean).join(' ')}
                      onMouseDown={(e) => {
                        if (editing === ref) return;
                        // Stops the browser starting a text selection across the grid, and keeps
                        // the keyboard on the grid rather than on whatever was focused before.
                        e.preventDefault();
                        grid.current?.focus();
                        select({ col: c, row: r }, e.shiftKey);
                      }}
                      onDoubleClick={() => edit({ col: c, row: r })}
                      title={err ? `${err.err} — ${err.detail}` : undefined}
                    >
                      {editing === ref ? (
                        // A textarea rather than an input, because the cell it replaces wraps: a
                        // line item long enough to take three lines must be editable as three
                        // lines. Enter still commits — a newline inside a cell is not stored.
                        <textarea
                          ref={input}
                          className="sheet-input"
                          rows={1}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commit(); move(0, 1, false); grid.current?.focus(); }
                            if (e.key === 'Escape') { e.preventDefault(); discarding.current = true; setEditing(null); grid.current?.focus(); }
                            if (e.key === 'Tab') { e.preventDefault(); commit(); move(1, 0, false); grid.current?.focus(); }
                          }}
                        />
                      ) : rows[String(r)] ? (
                        // A row given a height by hand has to be able to be made *shorter*, and a
                        // table row treats `height` as a floor. So a sized row puts its content in
                        // a box of exactly that height that clips — which is what dragging a row
                        // up does in Sheets. Only sized rows get the wrapper, so the ordinary path
                        // renders exactly the DOM it rendered before.
                        <span className="sheet-cell-fit">{display(v, f)}</span>
                      ) : (
                        display(v, f)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SheetTabs
        sheets={sheets}
        active={here}
        readOnly={readOnly}
        onPick={pick}
        onAdd={addSheet}
        onRename={rename}
        onRemove={removeSheet}
      />
    </div>
  );
}
