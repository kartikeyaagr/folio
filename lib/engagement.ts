/**
 * Read and dismissed, per person.
 *
 * Deliberately not a column on the story, the alert or the filing. Three people share this desk,
 * and one of them having read something says nothing about the other two — a shared "read" flag
 * means the second person to open the app never sees what the first one already cleared.
 *
 * Dismissing is stronger than reading and is the useful one: it is a person saying "this matched,
 * and it should not have". That is a signal about the matching, not just about the reader, which is
 * why it is kept rather than deleted.
 */

import { readTxn, writeTxn } from './db.ts';

export type SubjectKind = 'news' | 'alert' | 'filing';
export type EngagementState = 'read' | 'dismissed';

/**
 * Record that one person has read or dismissed one thing. Last write wins: marking read after
 * dismissing brings the item back, the same as `clear` does.
 *
 * **For news, `subjectRef` is the match id and not the article id.** `newsFor` selects `m.id` from
 * `news_matches` and joins engagement on it, so one article matched to two companies carries two
 * rows, and dismissing it under one name leaves it standing under the other. That is the right
 * reading of a dismissal — "this matched *this* company and should not have" is a judgement about
 * one match, which is what `dismissalsByTier` then counts. The trap is that `subject_ref` is a
 * bare text column with no foreign key, across three unrelated kinds: the wrong id writes a row
 * that nothing will ever join to, and nothing anywhere will say so.
 */
export async function mark(
  kind: SubjectKind,
  subjectRef: string,
  state: EngagementState,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      `INSERT INTO engagement (user_id, subject_kind, subject_ref, state)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, subject_kind, subject_ref)
       DO UPDATE SET state = EXCLUDED.state, at = now()`,
      [actorId, kind, subjectRef, state],
    );
  });
}

/** Undo. A dismissal is a judgement, and a judgement can be wrong. */
export async function clear(kind: SubjectKind, subjectRef: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      'DELETE FROM engagement WHERE user_id = $1 AND subject_kind = $2 AND subject_ref = $3',
      [actorId, kind, subjectRef],
    );
  });
}

export interface NewsForReader {
  id: string;
  title: string;
  url: string;
  source: string;
  mechanism: string;
  symbol: string;
  publishedAt: Date | null;
  state: EngagementState | null;
  /**
   * The other feeds that carried this same article, deduplicated away before the gate saw it.
   *
   * Kept rather than discarded because it says something the single row cannot: a story three
   * outlets ran independently got pickup, and one that appeared in a single trade title did not.
   */
  alsoIn: string[];
}

/**
 * Confirmed news as one person sees it.
 *
 * Dismissed items are excluded and read ones are marked rather than hidden — a story you have read
 * is still the story that happened, and hiding it makes the page disagree with your memory of it.
 */
export async function newsFor(
  userId: string,
  options: { companyId?: string; days?: number; includeDismissed?: boolean } = {},
): Promise<NewsForReader[]> {
  const { companyId = null, days = 14, includeDismissed = false } = options;
  return readTxn(async (c) => {
    const { rows } = await c.query<NewsForReader>(
      `SELECT m.id, i.title, i.url, s.label AS source, m.mechanism, co.symbol,
              i.published_at AS "publishedAt", e.state,
              COALESCE((
                SELECT array_agg(DISTINCT s2.label ORDER BY s2.label)
                  FROM news_items i2 JOIN news_sources s2 ON s2.key = i2.source_key
                 WHERE i2.id <> i.id
                   AND s2.key <> i.source_key
                   AND (i2.url_key = i.url_key
                        OR (i2.title_key IS NOT NULL AND i2.title_key = i.title_key))
              ), '{}') AS "alsoIn"
         FROM news_matches m
         JOIN news_items i ON i.id = m.item_id
         JOIN news_sources s ON s.key = i.source_key
         JOIN companies co ON co.id = m.company_id
         LEFT JOIN engagement e
           ON e.subject_kind = 'news' AND e.subject_ref = m.id AND e.user_id = $1
        WHERE m.state = 'confirmed'
          AND ($2::text IS NULL OR m.company_id = $2)
          AND COALESCE(i.published_at, i.fetched_at) > now() - ($3 || ' days')::interval
          AND ($4 OR e.state IS DISTINCT FROM 'dismissed')
        ORDER BY COALESCE(i.published_at, i.fetched_at) DESC`,
      [userId, companyId, String(days), includeDismissed],
    );
    return rows;
  });
}

/**
 * Matches people have dismissed, by how they were caught.
 *
 * The reason to keep dismissals rather than delete them: a tier that people dismiss most of the
 * time is a tier that is not working, and this is the only place that would ever show it.
 */
export async function dismissalsByTier(): Promise<
  { tier: string; confirmed: number; dismissed: number }[]
> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ tier: string; confirmed: number; dismissed: number }>(
      // `count(DISTINCT m.id)`, not `count(*)`. The LEFT JOIN fans a match out to one row per
      // engagement, and three people share this desk each keeping their own read/dismissed
      // state — so a story two of them touched counted twice. `dismissed` beside it was already
      // distinct, which is what made the two columns quietly incomparable, and comparing them is
      // the only thing this function is for: a tier inflated on the left looks better at
      // dismissing than it is.
      `SELECT m.tier,
              count(DISTINCT m.id)::int AS confirmed,
              count(DISTINCT e.subject_ref) FILTER (WHERE e.state = 'dismissed')::int AS dismissed
         FROM news_matches m
         LEFT JOIN engagement e ON e.subject_kind = 'news' AND e.subject_ref = m.id
        WHERE m.state = 'confirmed'
        GROUP BY m.tier
        ORDER BY dismissed DESC, m.tier`,
    );
    return rows;
  });
}
