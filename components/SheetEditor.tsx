'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { columnName, refName } from '@/lib/sheet/cells.ts';
import { evaluateSheet, isCellError, type Lookups, type Value } from '@/lib/sheet/evaluate.ts';

/**
 * The grid.
 *
 * Evaluated on the client as you type, so a model responds the way a spreadsheet is supposed to.
 * The **data** functions cannot be — they read this box's own figures — so they are resolved on the
 * server and handed in as `lookups`, and re-resolved on save when the set of calls has changed.
 * Everything else is the pure evaluator, running in the browser.
 *
 * A cell shows its **value**, except the one you are editing, which shows its formula. That is the
 * whole interaction model of every spreadsheet ever written and there is nothing to gain here by
 * being different.
 */

const COLS = 12;
const ROWS = 40;

const shown = (v: Value | undefined): string => {
  if (v === undefined || v === '') return '';
  if (isCellError(v)) return v.err;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '#NUM!';
    // Enough precision to be useful, not so much that a column of them stops lining up.
    return Math.abs(v) >= 1e9 || (Math.abs(v) < 1e-4 && v !== 0)
      ? v.toExponential(3)
      : String(Number(v.toFixed(4)));
  }
  return v;
};

export function SheetEditor({
  id,
  cells: initial,
  lookups: initialLookups,
  onSave,
  readOnly = false,
}: {
  id: string;
  cells: Record<string, string>;
  lookups: Lookups;
  /** The server action itself. It answers with the figures the saved grid now asks for. */
  onSave: (id: string, cells: Record<string, string>) => Promise<Lookups>;
  readOnly?: boolean;
}) {
  const [cells, setCells] = useState<Record<string, string>>(initial);
  const [lookups, setLookups] = useState<Lookups>(initialLookups);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<'clean' | 'saving' | 'dirty' | 'error'>('clean');
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const values = useMemo(() => evaluateSheet({ cells, lookups }), [cells, lookups]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const commit = (): void => {
    if (!editing) return;
    const next = { ...cells };
    if (draft.trim() === '') delete next[editing];
    else next[editing] = draft;
    setEditing(null);
    if (next[editing] !== cells[editing]) {
      setCells(next);
      setSaved('dirty');
    }
  };

  const open = (ref: string): void => {
    if (readOnly) return;
    commit();
    setEditing(ref);
    setDraft(cells[ref] ?? '');
  };

  const save = async (): Promise<void> => {
    commit();
    setSaved('saving');
    try {
      // A grid that gained a data call since the last save gets its answer here, without a reload.
      setLookups(await onSave(id, cells));
      setSaved('clean');
      setMessage(null);
    } catch (err) {
      // Said, not swallowed. A model whose save failed silently is a model somebody will close.
      setSaved('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  // The selected cell's own text and its error, which is where a `#N/A` gets to explain itself.
  const selected = editing ?? null;
  const selectedValue = selected ? values[selected] : undefined;

  return (
    <div className="sheet">
      <div className="sheet-bar">
        <span className="sheet-ref">{selected ?? '—'}</span>
        <span className="sheet-detail">
          {isCellError(selectedValue)
            ? `${selectedValue.err} — ${selectedValue.detail}`
            : selected
              ? (cells[selected] ?? '')
              : 'Pick a cell. Start with = for a formula.'}
        </span>
        {!readOnly && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void save()}
            disabled={saved === 'saving' || saved === 'clean'}
          >
            {saved === 'saving' ? 'Saving…' : saved === 'clean' ? 'Saved' : 'Save'}
          </button>
        )}
      </div>
      {message && <p className="alert">{message}</p>}

      <div className="tbl-scroll">
        <table className="tbl sheet-grid">
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} className="num">{columnName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr key={r}>
                <th className="sheet-rownum">{r + 1}</th>
                {Array.from({ length: COLS }, (_, c) => {
                  const ref = refName({ col: c, row: r });
                  const v = values[ref];
                  const err = isCellError(v) ? v : null;
                  return (
                    <td
                      key={ref}
                      className={[
                        'sheet-cell',
                        err ? 'is-err' : '',
                        typeof v === 'number' ? 'num' : '',
                        editing === ref ? 'is-editing' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => open(ref)}
                      title={err ? `${err.err} — ${err.detail}` : undefined}
                    >
                      {editing === ref ? (
                        <input
                          ref={input}
                          className="sheet-input"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commit(); }
                            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                            if (e.key === 'Tab') { e.preventDefault(); commit(); open(refName({ col: c + 1, row: r })); }
                          }}
                        />
                      ) : (
                        shown(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
