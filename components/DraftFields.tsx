import { label } from '@/lib/agents/paths.ts';
import { fieldsOf, within, type Field } from '@/lib/agents/shapes.ts';

import { Blank } from './ui.tsx';

/**
 * A draft, as a thing a reviewer can correct.
 *
 * Until now `/review` offered a textarea per top-level string and rendered everything else as
 * `JSON.stringify`. Two agents have nothing correctable at that level — a brief's judgement lives
 * at `by_company[0].why_it_matters` and a forensic verdict at `answers[3].verdict` — so both
 * scored ~0 however wrong they were, and a 0 that means *uncorrectable* reads as a 0 that means
 * *right*.
 *
 * **Shape-aware, not one recursive list.** A guidance change is judged by reading `previously`
 * against `now`, so a generic renderer that puts a labelled box between them makes the comparison
 * harder than the JSON did. A checklist is judged by running an eye down fourteen verdicts, which
 * a column can do and fourteen stacked blocks cannot. So a list of records is a table and a list of
 * lines is a list, and the top level stays the `<dl>` it was.
 *
 * `lib/agents/shapes.ts` decides what each position is. Nothing here reads a runtime type to
 * decide whether something is editable: `verdict` and `note` are both strings and only one of them
 * may be typed into.
 */

/** Every control's name, so the harvest in `app/_lib/actions/review.ts` is one grammar. */
const edit = (path: string): string => `f.${path}`;
const drop = (path: string): string => `d.${path}`;

/** A value that is shown and never typed into. */
function Fixed({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <Blank why="The agent returned nothing here" />;
  }
  return <span className="draft-text">{typeof value === 'string' ? value : JSON.stringify(value)}</span>;
}

function Leaf({ path, value, field }: { path: string; value: unknown; field: Field }) {
  if (field.kind === 'choice') {
    return (
      <select className="field draft-pick" name={edit(path)} defaultValue={String(value ?? '')} aria-label={label(path)}>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'text') {
    const v = typeof value === 'string' ? value : '';
    return (
      <textarea
        className="field draft-edit"
        name={edit(path)}
        defaultValue={v}
        rows={Math.min(14, Math.max(1, Math.ceil(v.length / 72)))}
        // An empty leaf and one nobody has reached look identical otherwise, and on a brief with
        // ninety positions that matters: the hatch is what the rest of this system uses to say
        // "deliberately blank" rather than "not filled in yet".
        placeholder="The agent returned nothing for this field"
        aria-label={label(path)}
      />
    );
  }
  return <Fixed value={value} />;
}

/** The checkbox that drops one element of a list. Quiet, because it is the rarer act. */
function Drop({ path }: { path: string }) {
  return (
    <label className="draft-drop">
      <input type="checkbox" name={drop(path)} value="1" />
      <span>drop</span>
    </label>
  );
}

/**
 * A list of records: one row each, the record's own fields as columns.
 *
 * `.tbl` inside `.tbl-scroll`, which the design system already styles with a sticky head — so
 * fourteen forensic verdicts read as one column rather than as fourteen blocks, and a guidance
 * change puts `previously` beside `now` where they can be compared.
 */
function Records({ path, value, of, removable }: { path: string; value: unknown[]; of: Field; removable: boolean }) {
  const columns = of.kind === 'group' ? of.fields.map(([k]) => k) : [];
  return (
    <div className="tbl-scroll">
      <table className="tbl draft-tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c.replace(/_/g, ' ')}</th>
            ))}
            {removable && <th />}
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const at = `${path}[${i}].${c}`;
                const f = within(of, c);
                const cell = (row as Record<string, unknown>)[c];
                return (
                  <td key={c} className={f?.kind === 'fixed' ? '' : 'cell-wrap'}>
                    {f === null ? <Fixed value={cell} /> : <Nested path={at} value={cell} field={f} />}
                  </td>
                );
              })}
              {removable && (
                <td>
                  <Drop path={`${path}[${i}]`} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A list of lines: one editable line each. */
function Lines({ path, value, of, removable }: { path: string; value: unknown[]; of: Field; removable: boolean }) {
  return (
    <ul className="draft-list">
      {value.map((v, i) => (
        <li key={i}>
          <Nested path={`${path}[${i}]`} value={v} field={of} />
          {removable && <Drop path={`${path}[${i}]`} />}
        </li>
      ))}
    </ul>
  );
}

/** One position, whatever shape it turns out to be. */
function Nested({ path, value, field }: { path: string; value: unknown; field: Field }) {
  if (field.kind === 'list') {
    if (!Array.isArray(value)) return <Fixed value={value} />;
    if (value.length === 0) return <span className="muted">none</span>;
    return field.of.kind === 'group' ? (
      <Records path={path} value={value} of={field.of} removable={field.removable} />
    ) : (
      <Lines path={path} value={value} of={field.of} removable={field.removable} />
    );
  }
  if (field.kind === 'group') {
    if (typeof value !== 'object' || value === null) return <Fixed value={value} />;
    return <Group path={path} value={value as Record<string, unknown>} field={field} />;
  }
  return <Leaf path={path} value={value} field={field} />;
}

function Group({ path, value, field }: { path: string; value: Record<string, unknown>; field: Field }) {
  return (
    <dl className="draft-fields">
      {fieldsOf(field, value).map(([k, f]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, ' ')}</dt>
          <dd>
            <Nested path={path === '' ? k : `${path}.${k}`} value={value[k]} field={f} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The whole draft.
 *
 * `order` is `ai_drafts.field_order` — what the agent wrote, captured because jsonb sorts keys by
 * length and then alphabetically. It governs the top level only; below that the order comes from
 * the declaration, which is the only place nested order exists.
 */
export function DraftFields({
  content,
  field,
  order,
}: {
  content: Record<string, unknown>;
  field: Field;
  order: string[] | null;
}) {
  const declared = fieldsOf(field, content);
  const byKey = new Map(declared);
  const keys = order
    ? [...order.filter((k) => byKey.has(k)), ...declared.map(([k]) => k).filter((k) => !order.includes(k))]
    : declared.map(([k]) => k);

  return (
    <dl className="draft-fields">
      {keys.map((k) => (
        <div key={k}>
          <dt>{k.replace(/_/g, ' ')}</dt>
          <dd>
            <Nested path={k} value={content[k]} field={byKey.get(k)!} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Which positions a reviewer cannot touch, named rather than left to be discovered.
 *
 * `figures` says whether any of them is a number, because the two have different reasons and a
 * sentence that gives both on a draft that has only one of them is a sentence that is half false.
 * A brief's read-only position is `symbol`, an identity; a results draft's are its filed figures.
 */
export function readOnly(
  content: Record<string, unknown>,
  field: Field,
): { paths: string[]; figures: boolean; identities: boolean } {
  const out: { path: string; numeric: boolean }[] = [];
  const walk = (value: unknown, f: Field | null, path: string): void => {
    if (f === null) return;
    if (f.kind === 'list' && Array.isArray(value)) {
      value.forEach((v, i) => walk(v, f.of, `${path}[${i}]`));
      return;
    }
    if (f.kind === 'group' && typeof value === 'object' && value !== null) {
      for (const [k, child] of fieldsOf(f, value as Record<string, unknown>)) {
        walk((value as Record<string, unknown>)[k], child, path === '' ? k : `${path}.${k}`);
      }
      return;
    }
    if (f.kind === 'fixed') out.push({ path, numeric: typeof value === 'number' });
  };
  walk(content, field, '');

  // The shape, not every position: "answers[].item" rather than fourteen of them.
  return {
    paths: [...new Set(out.map((p) => p.path.replace(/\[\d+\]/g, '[]')))],
    figures: out.some((p) => p.numeric),
    identities: out.some((p) => !p.numeric),
  };
}
