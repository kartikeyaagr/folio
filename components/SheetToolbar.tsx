'use client';

import {
  ALIGNS, FACES, SIZES, STYLES, TONES, VALIGNS,
  type Align, type Face, type Format, type NumberStyle, type Tone, type VAlign,
} from '@/lib/sheet/format.ts';

/**
 * The formatting ribbon.
 *
 * Google Sheets' toolbar rather than Excel's ribbon, because this is a web page and a page that
 * spends 120px of vertical height on tabbed groups of buttons is a page with less model on it. One
 * row, grouped by what the controls do to a cell: how the text reads, where it sits, what the
 * number means, and what colour it carries.
 *
 * **Every control acts on the selection, and shows the state of the anchor cell.** That is the
 * Sheets convention and the only one that survives a range: with `B2:D8` selected and B2 bold, the
 * B button is lit and pressing it clears bold across all twenty-one cells. Reading the state off
 * the whole range instead would need a third "mixed" state on every button to be honest, which is
 * a lot of chrome to explain a case nobody is confused by.
 *
 * What is deliberately not here: merged cells, borders and frozen panes. Each needs a model of its
 * own that a per-cell format cannot carry — a merge is a span over neighbours, a border belongs to
 * the edge *between* two cells rather than to either of them, and a freeze is a property of the
 * view rather than of any cell. They are the next three, not things this declines.
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
    aria-hidden="true"
  >
    {path}
  </svg>
);

const ALIGN_ICON: Record<Align, React.ReactNode> = {
  left: icon(<><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></>),
  center: icon(<><path d="M4 6h16" /><path d="M7 12h10" /><path d="M6 18h12" /></>),
  right: icon(<><path d="M4 6h16" /><path d="M10 12h10" /><path d="M7 18h13" /></>),
};

const VALIGN_ICON: Record<VAlign, React.ReactNode> = {
  top: icon(<><path d="M4 5h16" /><path d="M12 9v10" /><path d="m8 13 4-4 4 4" /></>),
  middle: icon(<><path d="M4 12h16" /><path d="M12 4v4M12 16v4" /></>),
  bottom: icon(<><path d="M4 19h16" /><path d="M12 5v10" /><path d="m8 11 4 4 4-4" /></>),
};

const WRAP_ICON = icon(<><path d="M4 6h16" /><path d="M4 12h12a3 3 0 0 1 0 6h-3" /><path d="M14 15l-3 3 3 3" /><path d="M4 18h4" /></>);
const CLEAR_ICON = icon(<><path d="M4 7h16" /><path d="M10 7V5h4v2" /><path d="M6 7l1 12h10l1-12" /><path d="M14 11l-4 4M10 11l4 4" /></>);

const TONE_LABEL: Record<Tone, string> = {
  navy: 'Navy', teal: 'Teal', red: 'Red', amber: 'Amber', muted: 'Grey',
};

export function SheetToolbar({
  format,
  selection,
  disabled,
  onPatch,
  onStepDp,
  onClear,
}: {
  /** The anchor cell's format — what the buttons light up from. */
  format: Format | undefined;
  /** `B2` or `B2:D8`, so it is never a guess what a press is about to change. */
  selection: string;
  disabled: boolean;
  onPatch: (patch: Partial<Format>) => void;
  onStepDp: (by: number) => void;
  onClear: () => void;
}) {
  /** Pressing the control that is already on turns it off, which every one of these needs. */
  const toggle = <K extends keyof Format>(key: K, value: Format[K]): void =>
    onPatch({ [key]: format?.[key] === value ? undefined : value } as Partial<Format>);

  return (
    <div className="sheet-tools" role="toolbar" aria-label="Formatting">
      <span className="sheet-tools-ref" title="What these controls will change">{selection}</span>

      <span className="sheet-tools-group">
        <button
          type="button" className="sheet-tool" disabled={disabled}
          aria-pressed={format?.bold === true} title="Bold"
          onClick={() => toggle('bold', true)}
        ><b>B</b></button>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          aria-pressed={format?.italic === true} title="Italic"
          onClick={() => toggle('italic', true)}
        ><i>I</i></button>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          aria-pressed={format?.underline === true} title="Underline"
          onClick={() => toggle('underline', true)}
        ><u>U</u></button>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          aria-pressed={format?.strike === true} title="Strikethrough"
          onClick={() => toggle('strike', true)}
        ><s>S</s></button>
      </span>

      <span className="sheet-tools-group">
        <label className="sheet-tools-label">
          <span className="sr-only">Typeface</span>
          <select
            className="field sheet-tool-select sheet-tool-face"
            disabled={disabled}
            value={format?.face ?? 'sans'}
            onChange={(e) => onPatch({ face: e.target.value as Face })}
          >
            {FACES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <label className="sheet-tools-label">
          <span className="sr-only">Size</span>
          <select
            className="field sheet-tool-select sheet-tool-size"
            disabled={disabled}
            value={format?.size ?? 10}
            onChange={(e) => onPatch({ size: Number(e.target.value) })}
          >
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </span>

      <span className="sheet-tools-group">
        {ALIGNS.map((a) => (
          <button
            key={a} type="button" className="sheet-tool" disabled={disabled}
            aria-pressed={format?.align === a} title={`Align ${a}`}
            onClick={() => toggle('align', a)}
          >{ALIGN_ICON[a]}</button>
        ))}
        {VALIGNS.map((v) => (
          <button
            key={v} type="button" className="sheet-tool" disabled={disabled}
            aria-pressed={format?.valign === v} title={`Align ${v}`}
            onClick={() => toggle('valign', v)}
          >{VALIGN_ICON[v]}</button>
        ))}
      </span>

      <span className="sheet-tools-group">
        <label className="sheet-tools-label">
          <span className="sr-only">Number format</span>
          <select
            className="field sheet-tool-select"
            disabled={disabled}
            value={format?.style ?? 'auto'}
            onChange={(e) => onPatch({ style: e.target.value as NumberStyle })}
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          title="Fewer decimal places" onClick={() => onStepDp(-1)}
        >.0</button>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          title="More decimal places" onClick={() => onStepDp(1)}
        >.00</button>
      </span>

      <span className="sheet-tools-group" role="group" aria-label="Text colour">
        <span className="sheet-tools-label" aria-hidden="true">A</span>
        {TONES.map((t) => (
          <button
            key={t} type="button" className={`sheet-swatch cf-ink-${t}`} disabled={disabled}
            aria-pressed={format?.ink === t} title={`${TONE_LABEL[t]} text`}
            onClick={() => toggle('ink', t)}
          >A</button>
        ))}
      </span>

      <span className="sheet-tools-group" role="group" aria-label="Fill colour">
        <span className="sheet-tools-label" aria-hidden="true">Fill</span>
        {TONES.map((t) => (
          <button
            key={t} type="button" className={`sheet-swatch is-fill cf-fill-${t}`} disabled={disabled}
            aria-pressed={format?.fill === t} title={`${TONE_LABEL[t]} fill`}
            onClick={() => toggle('fill', t)}
          />
        ))}
      </span>

      <span className="sheet-tools-group">
        {/* Wrapping is the grid's default, so this button turns it off — pressed means "clip". */}
        <button
          type="button" className="sheet-tool" disabled={disabled}
          aria-pressed={format?.clip !== true} title={format?.clip ? 'Clipped — press to wrap' : 'Wrapping — press to clip'}
          onClick={() => onPatch({ clip: format?.clip ? undefined : true })}
        >{WRAP_ICON}</button>
        <button
          type="button" className="sheet-tool" disabled={disabled}
          title="Clear formatting from the selection" onClick={onClear}
        >{CLEAR_ICON}</button>
      </span>
    </div>
  );
}
