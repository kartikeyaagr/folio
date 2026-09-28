/**
 * The review gate.
 *
 * Nothing an agent writes reaches the fund's record without a person accepting it. That is the
 * whole safety property of pointing a model at this system, and it is a security control as much
 * as a quality one: agents read filings and PDFs written by other people, so a crafted document
 * can carry instructions. A human accept is what stands between that and the record.
 *
 * **One agent is exempt, by the fund's decision of 28-Sep-2026:** the news brief is published the
 * moment it is written. The exception is `publishDraft` below, and it is kept to one agent here
 * and in the database alike.
 *
 * Accepting records **what the person changed**, field by field. The distance between what the
 * model said and what was signed off is the only honest measure of whether an agent is any good,
 * and it is invisible unless it is captured at the moment of acceptance.
 *
 * The draft row survives either way, as the record of what the model said, what it cost, and what
 * a person did about it.
 */


import { draftDistance, positions } from './distance.ts';
import { recordExemplar } from './exemplars.ts';
import { removeAt, setPath, UnwritablePath } from './paths.ts';
import { fieldAt, shapeFor } from './shapes.ts';
import { queueBriefMail } from '../briefs.ts';
import { readTxn, rowId, type Client, writeTxn } from '../db.ts';

export class UnknownDraft extends Error {}
export class AlreadyDecided extends Error {}
export class ReasonRequired extends Error {}
export class NotAChoice extends Error {}
export { UnwritablePath };


export interface PendingDraft {
  id: string;
  agentKey: string;
  agentLabel: string;
  companyId: string | null;
  symbol: string | null;
  content: Record<string, unknown>;
  sources: unknown[];
  verification: Record<string, unknown> | null;
  model: string;
  costUsd: string | null;
  createdAt: Date;
  /** The order the agent wrote its fields in; jsonb does not keep it. Null on older drafts. */
  fieldOrder: string[] | null;
}

/**
 * How many drafts are waiting — all of them, not a page of them.
 *
 * Separate from `pendingDrafts` because **a count and a page are different questions and only one
 * of them has a limit.** `/agents` wanted the number and was reading `pendingDrafts().length`,
 * which is the number *or fifty, whichever is smaller*, while the rail badge beside it counted with
 * no limit at all. Above fifty pending the two disagreed on the same screen, and the one stated as
 * a headline — "52 drafts waiting" against a badge reading 63 — was the wrong one.
 *
 * It also drops a 50-row read of `content`, `sources` and `verification` from a page that rendered
 * none of it.
 *
 * The predicate is `status = 'pending'` and must stay the same as the one below; they are two
 * readings of one queue.
 */
export async function pendingDraftCount(): Promise<number> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_drafts WHERE status = 'pending'",
    );
    return rows[0]?.n ?? 0;
  });
}

/**
 * The queue.
 *
 * Provenance comes back with every draft, deliberately. A queue that hides where its items came
 * from trains people to wave them through, which turns the gate into a formality.
 *
 * **Capped, and the caller has to say so.** `pendingDraftCount()` is the uncapped number; a screen
 * rendering `drafts.length` as "N waiting" is stating a fact it did not measure.
 */
export async function pendingDrafts(limit = 50): Promise<PendingDraft[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<PendingDraft>(
      `SELECT d.id, d.agent_key AS "agentKey", a.label AS "agentLabel",
              d.company_id AS "companyId", co.symbol, d.field_order AS "fieldOrder",
              d.content, d.sources, d.verification, d.model,
              d.cost_usd::text AS "costUsd", d.created_at AS "createdAt"
         FROM ai_drafts d
         JOIN agents a ON a.key = d.agent_key
         LEFT JOIN companies co ON co.id = d.company_id
        WHERE d.status = 'pending'
        ORDER BY d.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  });
}

/**
 * What the person changed, position by position, keyed by path.
 *
 * **Flat, and that is load-bearing.** `rule_observations.field` holds one of these keys and
 * `lib/agents/rules.ts` reads the correction back with a single-arrow `d.edits -> o.field`, while
 * `learning.ts` and `distil.ts` unpack the blob with `jsonb_object_keys` and `jsonb_each`. Nesting
 * `edits` to mirror the content would break all three silently — the arrow would return null and
 * `/rules` would show a candidate with no evidence under it, which §7 says must not be shown.
 *
 * For flat content this is byte-for-byte what it always returned: a top-level key is its own path.
 */
export function diffFields(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const p of positions(original, edited)) {
    if (JSON.stringify(p.from ?? null) !== JSON.stringify(p.to ?? null)) {
      out[p.path] = { from: p.from ?? null, to: p.to ?? null };
    }
  }
  return out;
}

/**
 * What a reviewer did to a draft before signing it off.
 *
 * Two gestures, because they are two different acts. Correcting a position is *"this is worded
 * wrongly"*; dropping one is *"the agent invented this"*. Blanking a textarea is not the second: a
 * cleared bullet renders as an empty `<li>` in the permanent document, and scores 1.0 — identical
 * to a total rewrite — so three of them would raise a rule about prose nobody was making a point
 * about.
 */
export interface Correction {
  /** Path → the text a person put there. Only text; a figure is never retypeable here. */
  edits?: Record<string, string>;
  /** Path of a list → the positions to drop from it. */
  drops?: Record<string, readonly number[]>;
}

/**
 * Apply a correction to what the agent wrote.
 *
 * Corrections first, then removals, and removals **deepest first** — dropping a company before the
 * bullet inside it would leave the bullet's path pointing at a company that has moved. Every step
 * goes through `setPath`/`removeAt`, which refuse a position that does not already exist and refuse
 * to retype anything that is not already text.
 */
function apply(content: Record<string, unknown>, correction: Correction): Record<string, unknown> {
  let out = content;
  for (const [path, value] of Object.entries(correction.edits ?? {})) out = setPath(out, path, value);

  const deepestFirst = Object.entries(correction.drops ?? {}).sort((a, b) => b[0].length - a[0].length);
  for (const [path, indices] of deepestFirst) out = removeAt(out, path, indices);
  return out;
}

/**
 * Refuse a value the agent's own schema does not allow, before Postgres does.
 *
 * `forensics_answers_verdict_check` raises 23514 on a verdict outside its four, and it raises it
 * *inside* the acceptance transaction — so a crafted POST, or a select that got past the browser,
 * would roll back the whole accept and hand the reviewer Next's default error page with every box
 * they had filled. Only what the person actually typed is checked: a value the model got wrong is
 * the agent's problem and this screen exists to catch it, not to refuse to open.
 */
function checkChoices(
  agentKey: string,
  content: Record<string, unknown>,
  edits: Record<string, string>,
): void {
  const declared = shapeFor(agentKey, content);
  for (const [path, value] of Object.entries(edits)) {
    const field = fieldAt(declared, path);
    if (field?.kind === 'choice' && field.enforced && !field.options.includes(value)) {
      throw new NotAChoice(`"${value}" is not one of ${field.options.join(', ')}`);
    }
  }
}

interface DraftRow {
  id: string;
  agent_key: string;
  company_id: string | null;
  content: Record<string, unknown>;
  status: string;
  /** What the agent saw, for the exemplar. Null on every draft written before R5a. */
  situation: string | null;
}

async function lockDraft(c: Client, draftId: string): Promise<DraftRow> {
  const { rows } = await c.query<DraftRow>(
    `SELECT id, agent_key, company_id, content, status, situation
       FROM ai_drafts WHERE id = $1 FOR UPDATE`,
    [draftId],
  );
  const d = rows[0];
  if (!d) throw new UnknownDraft(`no draft ${draftId}`);
  if (d.status !== 'pending') throw new AlreadyDecided(`draft ${draftId} is already ${d.status}`);
  return d;
}

/**
 * Accept a draft, optionally with edits, and write it where it belongs.
 *
 * The destination write is an ordinary attributed write that carries no reference back to the
 * draft. What lands in the record is the analyst's, not the agent's — the draft is how it got
 * drafted, not whose it is.
 */
export async function acceptDraft(
  draftId: string,
  /**
   * What the person changed, **applied to** what the agent wrote — a patch, not a replacement.
   *
   * A replacement would mean `/review` had to round-trip every position it cannot edit through the
   * form and back, so a draft's nested arrays would depend on a hidden input surviving a browser.
   * The fold happens here instead, against the row already held `FOR UPDATE`, so it cannot race a
   * second decision either. Null for accepting exactly what the agent wrote.
   *
   * A single-segment path behaves exactly as the shallow spread this used to do, which is why the
   * callers that hand it a flat object still mean what they meant.
   */
  correction: Correction | null,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    const draft = await lockDraft(c, draftId);
    if (correction?.edits) checkChoices(draft.agent_key, draft.content, correction.edits);
    const final = correction === null ? draft.content : apply(draft.content, correction);
    const edits = diffFields(draft.content, final);
    // Computed once, here, from code — the same discipline cost_usd follows. The alternative is
    // running word-level Levenshtein over jsonb on every render of /agents.
    //
    // The declaration is passed so that positions nobody may correct stay out of the denominator:
    // 15 of a forensic draft's 43 are read-only, and leaving them in capped a total repudiation of
    // that agent below the 0.25 that counts as one correction at all.
    const distance = draftDistance(draft.content, final, shapeFor(draft.agent_key, draft.content));

    await c.query(
      `UPDATE ai_drafts
          SET status='accepted', decided_by=$1, decided_at=now(), edits=$2, content=$3,
              edit_distance=$5
        WHERE id=$4`,
      [actorId, JSON.stringify(edits), JSON.stringify(final), draftId, distance],
    );

    await recordExemplar(c, draft, final, distance);

    if (draft.agent_key === 'forensics-review') {
      await landForensics(c, draft.company_id, final, actorId);
    } else {
      await landDocument(c, draft, final, actorId);
    }
  });
}

/**
 * The agents whose drafts enter the record unread. One, and it is meant to stay one.
 *
 * The same list is a CHECK on `ai_drafts` (`only_the_brief_skips_review`, migration 0067), so a
 * second entry here fails at the first publish until a migration agrees to it. That is the point.
 * Widening this is a decision about the fund's record, and it should not be a one-line code change.
 */
export const PUBLISHED_WITHOUT_REVIEW: ReadonlySet<string> = new Set(['news-brief']);

/**
 * Publish a draft nobody reviewed. **This is the exception to the gate, and it happens here.**
 *
 * By the fund's decision of 28-Sep-2026 the news brief is published the moment it is written and
 * mailed to every active user. It does not wait in /review. That sets aside, for this one agent, the
 * standard this file exists to enforce, so the exception keeps everything the gate would have kept
 * except the person:
 *
 *   - the draft row survives, marked `published` and decided by nobody, so the run, the model and
 *     the cost stay beside the document, and "not reviewed" is a fact on the record, not a gap in it;
 *   - the document lands through `landDocument`, the path every accepted draft takes, as
 *     `system:agents`, so it says a job wrote it rather than borrowing somebody's name;
 *   - **no exemplar is written.** Nobody signed it off, and an agent that learns from its own
 *     unreviewed output only reinforces whatever it already does. 0067 turns its learning off too;
 *   - it is announced to everybody in the same commit (`queueBriefMail`). Something that entered
 *     the record without anybody reading it should not also enter it without anybody being told.
 *
 * Called by the runner on the transaction that wrote the draft, so no state exists in which the
 * brief was written and not yet published.
 */
export async function publishDraft(c: Client, draftId: string): Promise<string> {
  const draft = await lockDraft(c, draftId);
  await c.query(
    "UPDATE ai_drafts SET status = 'published', decided_at = now() WHERE id = $1",
    [draftId],
  );
  const documentId = await landDocument(c, draft, draft.content, 'system:agents');
  await queueBriefMail(c, documentId);
  return documentId;
}

/** Agent 7's answers become a checklist against the company, at the version they were answered under. */
async function landForensics(
  c: Client,
  companyId: string | null,
  content: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  if (!companyId) throw new Error('a forensic review must belong to a company');
  const version = Number(content['version']);
  const answers = (content['answers'] ?? []) as { item: number; verdict: string; note: string }[];

  const checklistId = rowId();
  await c.query(
    `INSERT INTO forensics_checklists (id, company_id, version, drafted_by_agent)
     VALUES ($1,$2,$3,true)`,
    [checklistId, companyId, version],
  );
  for (const a of answers) {
    await c.query(
      'INSERT INTO forensics_answers (checklist_id, item, verdict, note) VALUES ($1,$2,$3,$4)',
      [checklistId, a.item, a.verdict, a.note ?? null],
    );
  }
  void actorId; // attribution comes from the transaction, not from a column here
}

/**
 * What kind of document each agent's work becomes.
 *
 * Everything landing as `note` made a brief indistinguishable from something somebody typed, and
 * "show me the last brief" unanswerable. Anything not named here is a note, which is the right
 * default for an agent added later.
 */
const DOCUMENT_KIND: Record<string, string> = {
  'news-brief': 'brief',
};

/**
 * What a draft may ask to become, when it asks.
 *
 * The map above is keyed by agent, which works while each agent writes one kind of thing. Agent 8
 * does not: a chat thread produces a note one day and a memo the next, and the kind is a choice
 * made in the conversation. So a draft whose content names a kind gets it — from this list only.
 *
 * Deliberately narrower than `documents_kind_check`. `transcript`, `brief`, `checklist` and `sheet`
 * each belong to a pipeline that produces them, and `meeting` to somebody who was in one; a draft
 * claiming to be one of those would misstate where it came from, which is the thing the column
 * exists to keep straight. `draft_document`'s own schema offers the same two, so this is the
 * second of two gates rather than the only one.
 */
const DRAFT_MAY_CHOOSE = new Set(['note', 'memo']);

/**
 * The kind the draft asked for, if it asked for one this list allows.
 *
 * Read from the content *after* the analyst's edits, so changing `kind` in the review screen
 * changes what lands — the same as every other field. An unrecognised value falls through to the
 * per-agent map rather than raising: a draft is not worth refusing at the moment of acceptance over
 * a field the reviewer can see and the agent can get wrong.
 */
function chosenKind(content: Record<string, unknown>): string | null {
  const kind = content['kind'];
  return typeof kind === 'string' && DRAFT_MAY_CHOOSE.has(kind) ? kind : null;
}

/** A title somebody can pick out of a list, without opening it. */
function documentTitle(agentKey: string, content: Record<string, unknown>): string {
  const headline = content['headline'];
  if (typeof headline === 'string' && headline.trim() !== '') return headline.slice(0, 200);

  if (agentKey === 'news-brief') {
    const period = typeof content['period'] === 'string' ? content['period'] : null;
    return period ? `Brief — ${period}`.slice(0, 200) : 'Brief';
  }
  return `${agentKey} draft`;
}

/** Everything else becomes a document, with its first version. */
async function landDocument(
  c: Client,
  draft: DraftRow,
  content: Record<string, unknown>,
  actorId: string,
): Promise<string> {
  const docId = rowId();
  await c.query(
    `INSERT INTO documents (id, company_id, title, kind, created_by, from_draft_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      docId, draft.company_id, documentTitle(draft.agent_key, content),
      chosenKind(content) ?? DOCUMENT_KIND[draft.agent_key] ?? 'note', actorId,
      // The link the review gate spends its whole design showing. Losing it at the moment of
      // acceptance is losing it exactly when it starts to matter.
      draft.id,
    ],
  );
  await c.query(
    'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
    [docId, JSON.stringify(content), actorId],
  );
  return docId;
}

/**
 * Reject a draft. A reason is required.
 *
 * A blank rejection teaches nobody anything, including whoever next revises the prompt. The
 * database enforces it too; this raises first so the caller gets a sentence rather than a
 * constraint name.
 */
export async function rejectDraft(
  draftId: string,
  reason: string,
  actorId: string,
): Promise<void> {
  if (!reason.trim()) {
    throw new ReasonRequired('Rejecting a draft needs a reason. A blank rejection teaches nothing.');
  }
  await writeTxn(actorId, async (c) => {
    await lockDraft(c, draftId);
    await c.query(
      `UPDATE ai_drafts SET status='rejected', decided_by=$1, decided_at=now(), reject_reason=$2
        WHERE id=$3`,
      [actorId, reason.trim(), draftId],
    );
  });
}
