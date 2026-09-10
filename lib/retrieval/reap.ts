/**
 * Retraction: the other half of "what is worth indexing."
 *
 * register.ts's five `INSERT … SELECT` statements each carry an inclusion predicate —
 * `archived_at IS NULL`, `state = 'confirmed'`, `superseded_by IS NULL`, and so on — but an INSERT
 * only ever governs what gets (re-)proposed. It cannot retract a row it no longer selects. A
 * document archived after it was registered, a fundamentals period restated after it was
 * registered, a news match rejected after it was confirmed and registered — each leaves a `sources`
 * row (and, via `chunks.source_id ON DELETE CASCADE`, its chunks) sitting there forever, unreachable
 * by any future `registerAll` call, because nothing ever asks it to leave.
 *
 * The first version of this file fixed exactly one of these — an archived document — with a
 * bespoke DELETE. This is that fix generalised: rather than writing a bespoke retraction per kind,
 * `reap()` builds one from the SAME SELECT that admits the kind, so a `sources` row survives a reap
 * only if its subject still satisfies the predicate that let it in. A WHERE clause added to a
 * `*_SELECT` in register.ts later narrows what survives automatically, with nothing here to update
 * — the same "single source of truth" argument register.ts already makes for `FILING_TEXT_SQL` and
 * `CURRENT_VERSION_ORDER_SQL`, applied once more here to eligibility itself.
 *
 * Why this matters more than the archived-document case it started from: a withdrawn memo kept
 * searchable is a stale opinion. A superseded financial figure kept searchable as though current is
 * a wrong number with no flag on it — the exact failure this system's whole posture (agent 1 shows
 * both readings rather than picking one, `costUsd` returns null rather than zero) exists to avoid.
 * Verified against the live database 10-Sep-2026, ahead of Task 9 building search on this table: 4
 * fundamentals periods and 5 news matches already need this — sitting in `sources`, unreachable,
 * right now. Neither is theoretical.
 */
import type { Client } from '../db.ts';
import type { SourceKind } from './register.ts';

/**
 * The complement of an inclusion predicate: a `sources` row of a given kind survives a reap only if
 * its ref_id still appears in the SELECT that admits that kind. The `kind` literal is interpolated,
 * not parameterised — safe here because every caller below passes one of the five fixed
 * `SourceKind` values, never anything from a request.
 */
function reap(kind: SourceKind, eligibleSelect: string): string {
  return `
    DELETE FROM sources s
     WHERE s.kind = '${kind}'
       AND NOT EXISTS (SELECT 1 FROM (${eligibleSelect}) elig WHERE elig.ref_id = s.ref_id)`;
}

/**
 * Retracts all five kinds down to what their own SELECT still admits. `eligible` is exactly the
 * five `*_SELECT` constants register.ts's own INSERTs use for admission, handed in rather than
 * imported — this module takes no runtime dependency on register.ts's internals, so the two files
 * cannot form an import cycle even though register.ts calls back into this one for `registerAll`.
 *
 * Callers run this before proposing anything new (see registerAll): a subject that stopped
 * qualifying is gone before it could coexist, even briefly, with its own absence from the SELECT
 * that would otherwise have kept it.
 */
export async function reapAll(c: Client, eligible: Record<SourceKind, string>): Promise<void> {
  for (const kind of Object.keys(eligible) as SourceKind[]) {
    await c.query(reap(kind, eligible[kind]));
  }
}
