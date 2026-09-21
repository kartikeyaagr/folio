/**
 * A document's typeface and size.
 *
 * **Set on the document, not on a selection**, and that is a constraint rather than a preference.
 * The body is markdown — `lib/prose/parse.ts` argues why, and `lib/retrieval/` counts character
 * offsets into it for citations — and markdown has nowhere to put "these four words are 14pt
 * Georgia". A per-word font control would therefore be a control that silently loses its own effect
 * on save, which is worse than not offering it.
 *
 * Per-document is also the honest reading of what the control is for. Nobody sets a memo in three
 * faces; they set the memo. So it is stored as a sibling of the text — `{text, face, size}` — which
 * costs the chunker nothing (it reads `.text`), survives every round trip, and is exactly what
 * `lib/export/docx.ts` needs to name a font in the exported file.
 */

import { FACES, SIZES, type Face } from '../sheet/format.ts';

export { FACES, SIZES };
export type { Face };

/** What a document is set in when nobody has chosen. Lora at 15.5px, which is `.prose`. */
export const DEFAULT_FACE: Face = 'serif';
export const DEFAULT_SIZE = 11;

export interface Typography {
  face: Face;
  size: number;
}

/** Read a body's typography, falling back to what `.prose` already does. */
export function typographyOf(body: unknown): Typography {
  const bodyRecord = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const face = FACES.some((f) => f.value === bodyRecord['face']) ? (bodyRecord['face'] as Face) : DEFAULT_FACE;
  const size = (SIZES as readonly number[]).includes(bodyRecord['size'] as number)
    ? (bodyRecord['size'] as number)
    : DEFAULT_SIZE;
  return { face, size };
}

/**
 * The classes a document body carries.
 *
 * The same `cf-face-*` and `cf-size-*` classes a cell uses, so one set of rules in
 * `app/globals.css` serves both and a memo and a model set in Serif 11 look the same.
 */
export const typographyClasses = (t: Typography): string =>
  `cf-face-${t.face} cf-size-${t.size}`;

/** What is stored, with the defaults left out — an untouched document stores `{text}` as before. */
export function typographyBody(text: string, t: Typography): Record<string, unknown> {
  return {
    text,
    ...(t.face === DEFAULT_FACE ? {} : { face: t.face }),
    ...(t.size === DEFAULT_SIZE ? {} : { size: t.size }),
  };
}
