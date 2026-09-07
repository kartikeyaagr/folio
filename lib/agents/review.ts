/**
 * The review gate.
 *
 * Nothing an agent writes reaches the fund's record without a person accepting it. That is the
 * whole safety property of pointing a model at this system, and it is a security control as much
 * as a quality one: agents read filings and PDFs written by other people, so a crafted document
 * can carry instructions. A human accept is what stands between that and the record.
 *
 * Accepting records **what the person changed**, field by field. The distance between what the
 * model said and what was signed off is the only honest measure of whether an agent is any good,
 * and it is invisible unless it is captured at the moment of acceptance.
 *
 * The draft row survives either way, as the record of what the model said, what it cost, and what
 * a person did about it.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, writeTxn, type Client } from '../db.ts';

export class UnknownDraft extends Error {}
export class AlreadyDecided extends Error {}
export class ReasonRequired extends Error {}

const id = (): string => randomBytes(16).toString('hex');

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
}

/**
 * The queue.
 *
 * Provenance comes back with every draft, deliberately. A queue that hides where its items came
 * from trains people to wave them through, which turns the gate into a formality.
 */
export async function pendingDrafts(limit = 50): Promise<PendingDraft[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<PendingDraft>(
      `SELECT d.id, d.agent_key AS "agentKey", a.label AS "agentLabel",
              d.company_id AS "companyId", co.symbol,
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

/** Field-by-field difference between what the model said and what was signed off. */
export function diffFields(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(original), ...Object.keys(edited)])) {
    const a = JSON.stringify(original[key] ?? null);
    const b = JSON.stringify(edited[key] ?? null);
    if (a !== b) out[key] = { from: original[key] ?? null, to: edited[key] ?? null };
  }
  return out;
}

interface DraftRow {
  agent_key: string;
  company_id: string | null;
  content: Record<string, unknown>;
  status: string;
}

async function lockDraft(c: Client, draftId: string): Promise<DraftRow> {
  const { rows } = await c.query<DraftRow>(
    'SELECT agent_key, company_id, content, status FROM ai_drafts WHERE id = $1 FOR UPDATE',
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
  edited: Record<string, unknown> | null,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    const draft = await lockDraft(c, draftId);
    const final = edited ?? draft.content;
    const edits = diffFields(draft.content, final);

    await c.query(
      `UPDATE ai_drafts SET status='accepted', decided_by=$1, decided_at=now(), edits=$2, content=$3
        WHERE id=$4`,
      [actorId, JSON.stringify(edits), JSON.stringify(final), draftId],
    );

    if (draft.agent_key === 'forensics-review') {
      await landForensics(c, draft.company_id, final, actorId);
    } else {
      await landDocument(c, draft, final, actorId);
    }
  });
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

  const checklistId = id();
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

/** Everything else becomes a document, with its first version. */
async function landDocument(
  c: Client,
  draft: DraftRow,
  content: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  const docId = id();
  const title =
    typeof content['headline'] === 'string' && content['headline'].trim() !== ''
      ? String(content['headline']).slice(0, 200)
      : `${draft.agent_key} draft`;

  await c.query(
    `INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ($1,$2,$3,'note',$4)`,
    [docId, draft.company_id, title, actorId],
  );
  await c.query(
    'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
    [docId, JSON.stringify(content), actorId],
  );
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
