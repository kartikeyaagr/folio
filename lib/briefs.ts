/**
 * Briefs: the ones on the record, and the mail each new one becomes.
 *
 * A brief is a document, and a document is the thing that survives. The draft it came from is kept
 * beside it, so "who agreed to this, and what did the agent originally write" stays answerable
 * after the fact rather than only in the queue. Since 28-Sep-2026 nobody agrees to a new brief:
 * each one is published the moment it is written (`publishDraft` in ./agents/review.ts), and its
 * draft says so. The briefs a person accepted before then keep saying who did.
 */

import { readTxn, rowId, type Client } from './db.ts';

export interface BriefSummary {
  id: string;
  title: string;
  writtenAt: Date;
  /** Who accepted it. Null for a published brief, which nobody did. */
  acceptedBy: string | null;
  /** Published without review: every brief since 28-Sep-2026. */
  published: boolean;
  /** Who asked for it. Null for the day's scheduled brief, which nobody asked for. */
  askedBy: string | null;
  /** How many names the brief actually said something about. */
  covered: number;
  quiet: number;
  /** How many major updates it carried. Null for a brief written before it carried any (0068). */
  major: number | null;
  fromDraftId: string | null;
}

export interface BriefDocument extends BriefSummary {
  content: Record<string, unknown>;
  /**
   * What a reviewer changed before accepting, keyed by path — `by_company[0].why_it_matters`.
   *
   * **An object, not an array**, which it always was: `diffFields` builds it as
   * `{path: {from, to}}`. Typed as an array here since R5a, so `edits.length` was `undefined`,
   * `undefined > 0` was false, and the "Changed before it was accepted" card on
   * `/news/brief/[id]` never rendered for any brief however heavily corrected — and would have
   * thrown on `.map` if it ever had. Nothing failed, because nothing ran.
   */
  edits: Record<string, { from: unknown; to: unknown }> | null;
  model: string | null;
  costUsd: string | null;
}

const SUMMARY = `
  SELECT d.id, d.title, v.written_at AS "writtenAt", u.name AS "acceptedBy",
         d.from_draft_id AS "fromDraftId",
         COALESCE(dr.status = 'published', false) AS published,
         asker.name AS "askedBy",
         COALESCE(jsonb_array_length(v.body->'by_company'), 0) AS covered,
         COALESCE(jsonb_array_length(v.body->'nothing_to_report'), 0) AS quiet,
         jsonb_array_length(v.body->'major_updates') AS major
    FROM documents d
    JOIN LATERAL (
      SELECT body, written_at, written_by FROM document_versions
       WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
    ) v ON true
    LEFT JOIN users u ON u.id = v.written_by
    LEFT JOIN ai_drafts dr ON dr.id = d.from_draft_id
    LEFT JOIN agent_runs r ON r.id = dr.run_id
    LEFT JOIN users asker ON asker.id = r.requested_by
   WHERE d.kind = 'brief' AND d.archived_at IS NULL`;

export async function briefs(limit = 30): Promise<BriefSummary[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<BriefSummary>(
      `${SUMMARY} ORDER BY v.written_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  });
}

export async function brief(id: string): Promise<BriefDocument | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<BriefDocument>(
      `SELECT s.*, v.body AS content, dr.edits, dr.model, dr.cost_usd::text AS "costUsd"
         FROM (${SUMMARY} AND d.id = $1) s
         JOIN LATERAL (
           SELECT body FROM document_versions
            WHERE document_id = s.id ORDER BY written_at DESC LIMIT 1
         ) v ON true
         LEFT JOIN ai_drafts dr ON dr.id = s."fromDraftId"`,
      [id],
    );
    return rows[0] ?? null;
  });
}

/** A run queued and not yet finished, so the page can say the brief is on its way. */
export async function briefInFlight(): Promise<boolean> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agent_runs
          WHERE agent_key = 'news-brief' AND status IN ('queued', 'running')) AS ok`,
    );
    return rows[0]!.ok;
  });
}

/**
 * The one check both doors onto the brief make before queueing one: `askForBrief` (its own page)
 * and `askAgent` (`/chat`, which offers every invocable agent including this one). Two brief
 * requests in the same window are the same run paid for twice and mailed to everybody twice, so
 * the refusal — and its wording — lives here once rather than in each caller.
 *
 * Returns the sentence to show the asker, or null when it is safe to queue one.
 */
export async function pendingBrief(): Promise<string | null> {
  return (await briefInFlight())
    ? 'A brief is already being written. It will be here, and in everybody’s inbox, shortly.'
    : null;
}

/**
 * The windows a person may ask a brief to cover, in days.
 *
 * The day's scheduled brief covers 24 hours and none of these does, so a brief somebody asks for
 * is never a second copy of the morning's. Checked by `askForBrief`, not only offered by the page's
 * `<select>`, because the value posted back is whatever the browser sent.
 */
export const ASKABLE_DAYS: readonly number[] = [3, 7, 14, 30];

// ------------------------------------------------------------------------------------------------
// Where it came from
// ------------------------------------------------------------------------------------------------

export type Provenance = Pick<BriefSummary, 'writtenAt' | 'published' | 'acceptedBy' | 'askedBy'>;

/**
 * Who wrote a brief and who, if anybody, read it first, on one line.
 *
 * Shared by the page and the mail, so the two cannot disagree about whether a brief was reviewed.
 * The time comes in already formatted, because each surface formats dates its own way: the page
 * with `weekdayTime` in components/ui.tsx, the mail with `istStamp` below. Both read
 * "Mon 28 Sep, 08:03".
 */
export function provenance(b: Provenance, at: string): string {
  if (!b.published) return `Accepted by ${b.acceptedBy ?? 'somebody'} · ${at}`;
  const asked = b.askedBy ? `Asked for by ${b.askedBy} · written` : 'Written';
  return `${asked} by the news brief agent · ${at} · not reviewed`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Mon 28 Sep" and "08:03" in IST, the parts `weekdayTime` gives the page.
 *
 * A copy, because lib/ cannot import components/. The month is spelled from the list above for
 * the reason components/ui.tsx gives: en-GB renders September as "Sept".
 */
function istParts(at: Date): { day: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)) {
    p[part.type] = part.value;
  }
  return {
    day: `${p['weekday'] ?? ''} ${p['day'] ?? ''} ${MONTHS[Number(p['month']) - 1] ?? ''}`,
    time: `${p['hour'] ?? ''}:${p['minute'] ?? ''}`,
  };
}

const istStamp = (at: Date): string => {
  const p = istParts(at);
  return `${p.day}, ${p.time}`;
};

// ------------------------------------------------------------------------------------------------
// The brief as mail
// ------------------------------------------------------------------------------------------------

/** The string elements of a list. Stored jsonb is read back untyped, so the shape is checked. */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Each `by_company` element that has a symbol, as components/Brief.tsx reads it too. */
function companies(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['symbol'] === 'string');
}

export interface MajorUpdate {
  /** Where it sits in `major_updates`, which a dropped malformed element makes differ from here. */
  index: number;
  what_happened: string;
  why_it_matters: string;
  outlets: string[];
}

/**
 * A brief's major updates, read the one way both the mail and components/Brief.tsx read them.
 *
 * **Null and empty are different answers.** Null is a brief written before the section existed
 * (0068), which shows nothing where it would be. Empty is a brief that reported none, which is
 * said on the page and in the mail rather than left out, or it would read as a quiet market.
 */
export function majorUpdates(value: unknown): MajorUpdate[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((v, index): MajorUpdate[] => {
    if (typeof v !== 'object' || v === null) return [];
    const u = v as Record<string, unknown>;
    if (typeof u['what_happened'] !== 'string') return [];
    return [{
      index,
      what_happened: u['what_happened'],
      why_it_matters: typeof u['why_it_matters'] === 'string' ? u['why_it_matters'] : '',
      outlets: strings(u['outlets']),
    }];
  });
}

/**
 * What a brief holds, in a few words: "1 name, 2 quiet, 4 major updates".
 *
 * The mail's subject and the page's list of earlier briefs, so the two cannot count differently.
 * A part that would be a zero is left out rather than written: "0 names" on a morning nobody is
 * followed reads as a book that was looked at and found empty. The one exception is a brief that
 * reported no major updates, which says so, because that one is news.
 */
export function tally(t: { covered: number; quiet: number; major: number | null }): string {
  const parts: string[] = [];
  if (t.covered > 0) parts.push(`${t.covered} ${t.covered === 1 ? 'name' : 'names'}`);
  if (t.quiet > 0) parts.push(`${t.quiet} quiet`);
  if (t.major !== null) {
    parts.push(t.major === 0
      ? 'no major updates'
      : `${t.major} major ${t.major === 1 ? 'update' : 'updates'}`);
  }
  return parts.length === 0 ? 'nothing in it' : parts.join(', ');
}

/**
 * The brief's content as plain text, section by section.
 *
 * **The one rendering of a brief outside the app. A section added to the brief is added here**,
 * and in `components/Brief.tsx`, which renders the same content on the page. Plain text and no
 * HTML, for the digest's reason (`composeDigest`): an HTML mail is a second rendering to keep in
 * step, and `Sender` carries text only. Headings are drawn the way the digest draws them, so the two
 * mails a person gets from this system look like they came from the same one.
 */
export function briefText(content: Record<string, unknown>): string {
  const out: string[] = [];
  const headline = content['headline'];
  if (typeof headline === 'string' && headline !== '') out.push(headline, '');

  for (const co of companies(content['by_company'])) {
    out.push(`── ${String(co['symbol'])} ──`, '');
    out.push(...strings(co['what_happened']).map((line) => `  • ${line}`));
    const why = co['why_it_matters'];
    if (typeof why === 'string' && why !== '') out.push('', `  ${why}`);
    out.push('');
  }

  // Named even though nothing happened to them. A brief that lists only the names with something
  // to say leaves a reader unable to tell "nothing happened" from "nobody looked".
  const quiet = strings(content['nothing_to_report']);
  if (quiet.length > 0) out.push('── Nothing to report ──', '', `  ${quiet.join(' · ')}`, '');

  const major = majorUpdates(content['major_updates']);
  if (major !== null) {
    out.push('── Major updates ──', '');
    if (major.length === 0) out.push('  None reported.', '');
    for (const u of major) {
      out.push(`  • ${u.what_happened}`);
      if (u.why_it_matters !== '') out.push(`    ${u.why_it_matters}`);
      out.push(`    ${u.outlets.length > 0 ? u.outlets.join(' · ') : 'No outlet named.'}`, '');
    }
  }

  const coming = strings(content['coming_up']);
  if (coming.length > 0) out.push('── Coming up ──', '', ...coming.map((line) => `  • ${line}`), '');

  return out.length === 0 ? 'This brief has no content.\n' : out.join('\n');
}

/**
 * The mail a brief becomes: the same subject and body for everybody.
 *
 * The subject says what is inside, for the digest's reason: a subject line that says only "Brief"
 * makes the decision to open it every morning rather than once.
 */
export function briefMail(
  content: Record<string, unknown>,
  about: Provenance,
): { subject: string; body: string } {
  // The counts, never the headline. The headline is what the model wrote from other people's text,
  // and a subject is a header.
  const subject = `Folio brief — ${istParts(about.writtenAt).day}: ` + tally({
    covered: companies(content['by_company']).length,
    quiet: strings(content['nothing_to_report']).length,
    major: majorUpdates(content['major_updates'])?.length ?? null,
  });

  const period = typeof content['period'] === 'string' && content['period'] !== ''
    ? content['period'] : 'Brief';
  const body = [
    period,
    provenance(about, istStamp(about.writtenAt)),
    '',
    briefText(content),
    'Nobody read this before it was sent. It is kept on Folio under News, then Brief.',
    '',
    'Folio',
  ].join('\n');
  return { subject, body };
}

/**
 * Queue a newly published brief for every active user, on the transaction that published it.
 *
 * The outbox's own rule, applied to the brief: a notification is queued in the same commit as the
 * thing it is about, so there is no state in which the brief is on the record and nobody was ever
 * going to be told. Kind `brief`, which `lib/digest.ts` leaves alone: these go out on their own as
 * soon as the agents job has drained the run (`drainOutbox(…, 'brief')` in jobs/agents.ts), and
 * are stamped sent there.
 *
 * Returns how many people it was queued for.
 */
export async function queueBriefMail(c: Client, documentId: string): Promise<number> {
  const { rows } = await c.query<{
    content: Record<string, unknown>; writtenAt: Date; askedBy: string | null;
  }>(
    `SELECT v.body AS content, v.written_at AS "writtenAt", asker.name AS "askedBy"
       FROM documents d
       JOIN document_versions v ON v.document_id = d.id
       JOIN ai_drafts dr ON dr.id = d.from_draft_id
       JOIN agent_runs r ON r.id = dr.run_id
       LEFT JOIN users asker ON asker.id = r.requested_by
      WHERE d.id = $1`,
    [documentId],
  );
  const b = rows[0];
  if (!b) throw new Error(`no published brief ${documentId} to mail`);

  const { subject, body } = briefMail(b.content, {
    writtenAt: b.writtenAt, published: true, acceptedBy: null, askedBy: b.askedBy,
  });
  const { rows: people } = await c.query<{ id: string }>(
    'SELECT id FROM users WHERE disabled_at IS NULL ORDER BY email',
  );
  for (const p of people) {
    await c.query(
      `INSERT INTO notification_outbox (id, kind, recipient, subject, body)
       VALUES ($1, 'brief', $2, $3, $4)`,
      [rowId(), p.id, subject, body],
    );
  }
  return people.length;
}
