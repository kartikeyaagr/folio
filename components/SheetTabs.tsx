'use client';

import { useEffect, useRef, useState } from 'react';

import type { Grid } from '@/lib/sheet/evaluate.ts';

/**
 * The tabs along the bottom of a workbook.
 *
 * At the bottom because that is where every spreadsheet anybody on this desk has used puts them,
 * and a control whose position has been fixed by thirty years of convention is not the place to
 * have an opinion.
 *
 * **Renaming is the dangerous one**, so it is the one the parent handles: a formula says
 * `=Inputs!B4` by name, and a tab renamed without rewriting what points at it turns every such cell
 * into `#REF!`. Double-click to rename, which is the same gesture as in Excel and Sheets.
 */
export function SheetTabs({
  sheets,
  active,
  readOnly,
  onPick,
  onAdd,
  onRename,
  onRemove,
}: {
  sheets: Grid[];
  active: number;
  readOnly: boolean;
  onPick: (index: number) => void;
  onAdd: () => void;
  onRename: (index: number, name: string) => void;
  onRemove: (index: number) => void;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming !== null) input.current?.select();
  }, [renaming]);

  const startRename = (index: number): void => {
    if (readOnly) return;
    setDraft(sheets[index]?.name ?? '');
    setRenaming(index);
  };

  const commitRename = (): void => {
    if (renaming === null) return;
    const index = renaming;
    setRenaming(null);
    const wanted = draft.trim();
    if (wanted && wanted !== sheets[index]?.name) onRename(index, wanted);
  };

  return (
    <div className="sheet-tabs">
      {sheets.map((sheet, i) => (
        <div key={i} className={`sheet-tab${i === active ? ' is-active' : ''}`}>
          {renaming === i ? (
            <input
              ref={input}
              className="sheet-tab-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
              }}
            />
          ) : (
            <button
              type="button"
              aria-current={i === active}
              onClick={() => onPick(i)}
              onDoubleClick={() => startRename(i)}
              title={readOnly ? sheet.name : `${sheet.name} — double-click to rename`}
            >
              {sheet.name}
            </button>
          )}
          {/* Only on the tab you are on, and only when there is another one to fall back to: a
              workbook with no tabs is not a state the grid can render or a person can act on. */}
          {!readOnly && i === active && sheets.length > 1 && renaming !== i && (
            <button
              type="button"
              className="sheet-tab-x"
              onClick={() => onRemove(i)}
              title={`Remove ${sheet.name}. Takes effect when you save, and the version before it is kept.`}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="sheet-tab-add" onClick={onAdd} title="Add a tab">
          +
        </button>
      )}
    </div>
  );
}
