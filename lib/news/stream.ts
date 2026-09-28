/**
 * The stream: every story from the outlets that feed it, one row per story.
 *
 * A story is the items sharing a `story_id` (`stories.ts`), read only from sources that are active
 * and `in_stream` (0065). Nothing is scored. The one ordering besides time is how many outlets
 * carry a story, which is a count of publishers, not a judgement — three papers running one
 * article is a different event from one trade title running it.
 *
 * **Which carrier a row shows.** The earliest one that passes the filters: unfiltered, the outlet
 * that ran it first; under an outlet filter, that outlet's own headline and link. The row's
 * time is that carrier's, and so is the window test — so a story that was already running before
 * the window opened is not shown as new because a second outlet picked it up inside it. The
 * outlets list and its count are always the whole story's, whatever the filter.
 */

import { readTxn, type Client } from '../db.ts';

/** The sections 0065 allows, in the order a reader scans them. */
export const SECTIONS = [
  'india', 'world', 'politics', 'business', 'companies', 'markets', 'economy', 'industry', 'tech',
  'official',
] as const;
export type Section = (typeof SECTIONS)[number];

export const isSection = (s: string | null | undefined): s is Section =>
  (SECTIONS as readonly string[]).includes(s ?? '');

export interface Story {
  /** The story's own id, which is its first item's. */
  id: string;
  title: string;
  url: string;
  /** When the carrier shown published it; null when its feed gave no date. */
  publishedAt: Date | null;
  /** What the stream orders by: `publishedAt`, else when the item was fetched. */
  at: Date;
  outlet: string;
  /** Null only for a source no migration classified, which the seeds never leave. */
  section: Section | null;
  /** Every stream outlet carrying the story, the one shown first, then by who ran it first. */
  outlets: string[];
  outletCount: number;
  /** Companies a confirmed match ties to any item of the story: the matches the Ours tab shows. */
  companies: string[];
}

interface Query {
  hours: number;
  section: string | null;
  outlet: string | null;
  limit: number;
  offset: number;
  byReach: boolean;
}

async function stories(c: Client, q: Query): Promise<{ stories: Story[]; total: number }> {
  const { rows } = await c.query<Story & { total: number }>(
    `WITH shown AS (
       SELECT DISTINCT ON (COALESCE(i.story_id, i.id))
              COALESCE(i.story_id, i.id) AS story, i.title, i.url, i.published_at,
              COALESCE(i.published_at, i.fetched_at) AS at, s.outlet, s.section
         FROM news_items i
         JOIN news_sources s ON s.key = i.source_key
        WHERE s.active AND s.in_stream
          AND COALESCE(i.published_at, i.fetched_at) > now() - make_interval(hours => $1)
          AND ($2::text IS NULL OR s.section = $2)
          AND ($3::text IS NULL OR s.outlet = $3)
        ORDER BY COALESCE(i.story_id, i.id), COALESCE(i.published_at, i.fetched_at), i.id
     ),
     stories AS (
       SELECT sh.*,
              ARRAY(
                SELECT o.outlet
                  FROM news_items i2
                  JOIN news_sources o ON o.key = i2.source_key
                 WHERE COALESCE(i2.story_id, i2.id) = sh.story AND o.active AND o.in_stream
                 GROUP BY o.outlet
                 ORDER BY o.outlet = sh.outlet DESC,
                          min(COALESCE(i2.published_at, i2.fetched_at)), o.outlet
              ) AS outlets,
              ARRAY(
                SELECT DISTINCT co.symbol
                  FROM news_items i3
                  JOIN news_matches m ON m.item_id = i3.id AND m.state = 'confirmed'
                  JOIN companies co ON co.id = m.company_id
                 WHERE COALESCE(i3.story_id, i3.id) = sh.story
                 ORDER BY co.symbol
              ) AS companies
         FROM shown sh
        -- Already running before the window opened, in the carriers these filters admit.
        WHERE NOT EXISTS (
          SELECT 1
            FROM news_items e
            JOIN news_sources es ON es.key = e.source_key
           WHERE COALESCE(e.story_id, e.id) = sh.story
             AND es.active AND es.in_stream
             AND ($2::text IS NULL OR es.section = $2)
             AND ($3::text IS NULL OR es.outlet = $3)
             AND COALESCE(e.published_at, e.fetched_at) <= now() - make_interval(hours => $1)
        )
     )
     SELECT story AS id, title, url, published_at AS "publishedAt", at, outlet, section, outlets,
            cardinality(outlets) AS "outletCount", companies,
            (count(*) OVER ())::int AS total
       FROM stories
      ORDER BY CASE WHEN $5 THEN cardinality(outlets) END DESC NULLS LAST, at DESC, story
      LIMIT $4 OFFSET $6`,
    [q.hours, q.section, q.outlet, q.limit, q.byReach, q.offset],
  );
  return { stories: rows, total: rows[0]?.total ?? 0 };
}

/**
 * Stories newest first, one row per story, within the last `hours`.
 *
 * `total` is every story the filters admit in the window; `stories` is the `limit` of them after
 * `offset`. A page showing fewer than `total` must say so, or a cut list reads as a quiet day: the
 * 24 hours to 16:00 on 28-Sep-2026 held 1,675 stories.
 */
export async function stream(options: {
  hours?: number; section?: string | null; outlet?: string | null; limit?: number; offset?: number;
} = {}): Promise<{ stories: Story[]; total: number }> {
  const { hours = 24, section = null, outlet = null, limit = 200, offset = 0 } = options;
  return readTxn((c) => stories(c, { hours, section, outlet, limit, offset, byReach: false }));
}

/**
 * The last `hours` of stories, most widely carried first and then newest.
 *
 * For the brief: what several outlets ran is what the day was about. The order is a count of
 * publishers, never a model's view of importance.
 */
export async function mostCarried(hours: number, limit = 50): Promise<Story[]> {
  return readTxn(async (c) =>
    (await stories(c, { hours, section: null, outlet: null, limit, offset: 0, byReach: true }))
      .stories);
}

/** What the stream can be filtered by, and when its feeds were last asked. */
export async function streamFacets(): Promise<{
  sections: Section[];
  outlets: string[];
  lastPolledAt: Date | null;
}> {
  return readTxn(async (c) => {
    const { rows: [row] } = await c.query<{
      sections: string[]; outlets: string[]; lastPolledAt: Date | null;
    }>(
      `SELECT ARRAY(SELECT DISTINCT section FROM news_sources
                     WHERE active AND in_stream AND section IS NOT NULL) AS sections,
              ARRAY(SELECT DISTINCT outlet FROM news_sources
                     WHERE active AND in_stream ORDER BY outlet) AS outlets,
              (SELECT max(last_polled_at) FROM news_sources
                WHERE active AND in_stream) AS "lastPolledAt"`,
    );
    return {
      sections: SECTIONS.filter((s) => row?.sections.includes(s)),
      outlets: row?.outlets ?? [],
      lastPolledAt: row?.lastPolledAt ?? null,
    };
  });
}
