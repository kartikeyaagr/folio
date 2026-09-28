/**
 * One story, however many outlets carry it.
 *
 * Every item points at the first item stored of the same story (`news_items.story_id`, 0065), and a
 * story's first item points at itself. Two items are the same story when they have the same
 * `url_key` or the same `title_key` — 0027's exact keys — within `SAME_STORY_DAYS`. Equality and
 * never similarity: the clustering C7 declined was measured in v2 at 100 items to 95 stories, 90 of
 * them singletons, and nothing here reopens it. What this collapses is the same article, which is
 * not rare: 8% of 2,089 real items in 0027's measurement, and more once three wire-fed papers carry
 * one PTI story under one headline.
 *
 * **The window is measured from the story's first item, not from whichever carrier matched.**
 * Measuring pairwise would let a headline that recurs — a daily column under a fixed title — chain
 * one story forward a day at a time for ever, the failure `SAME_STORY_DAYS` exists to stop.
 * The keys are still matched against every carrier, so an article that changed its headline after
 * a second outlet ran it under the first one is still found by its URL.
 *
 * **A URL joins items from different feeds, never two items of one feed.** `url_key` drops the
 * query string, which is right for the tracking tags every stream feed appends (at_medium=RSS,
 * utm_source) and wrong for RBI, whose query string is the article: every press release links to
 * BS_PressReleaseDisplay.aspx?prid=N. On 28-Sep-2026 that made ten different releases one story.
 * A feed repeating one article repeats its headline too — BBC business listed three twice, each
 * under one title — so within a feed the headline decides.
 */

import type { Client } from '../db.ts';
import { SAME_STORY_DAYS } from './match.ts';

export interface Assigned {
  /** Items given a story this call. */
  assigned: number;
  /** Of those, how many joined a story already running rather than starting one. */
  joined: number;
}

/**
 * Give every item that has no story one, oldest first, inside the caller's transaction.
 *
 * **It sweeps rather than taking a list.** It asks what has no story yet (`story_id IS NULL`), the
 * house rule for sweeps, so an item stored by any other path — and every item already stored when
 * 0065 added the column — is picked up by the next poll through this code, and there is one
 * definition of a story rather than a SQL backfill that could drift from it. Oldest first, so that
 * within one sweep the earliest carrier becomes the story's first item.
 *
 * **It takes a transaction-scoped advisory lock first, and it has to.** `pollFeeds` stores eight
 * feeds at once, each in its own transaction, and one article reaching two of them in the same
 * poll is ordinary — BusinessLine puts one URL in two feeds (0027). Without the lock each
 * transaction sees only its own uncommitted row, finds nothing to join, and both become the first
 * item of two stories that are one. The lock is taken before the sweep reads anything, so the
 * second transaction's reads begin after the first has committed and it joins the first's story.
 * It is held only while one feed's new items are assigned.
 */
export async function assignStories(c: Client): Promise<Assigned> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('news_items.story_id'))");

  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM news_items
      WHERE story_id IS NULL
      ORDER BY COALESCE(published_at, fetched_at), id`,
  );

  let joined = 0;
  for (const { id } of rows) {
    // A story is found through any carrier's keys, and bounded by its first item's time. A NULL
    // title_key — a headline that folds to nothing — matches nothing, never another NULL.
    const { rows: [row] } = await c.query<{ joined: boolean }>(
      `UPDATE news_items n
          SET story_id = COALESCE((
                SELECT m.story_id
                  FROM news_items m
                  JOIN news_items head ON head.id = m.story_id
                 WHERE ((m.url_key = n.url_key AND m.source_key <> n.source_key)
                        OR m.title_key = n.title_key)
                   AND abs(extract(epoch FROM
                         COALESCE(head.published_at, head.fetched_at)
                       - COALESCE(n.published_at, n.fetched_at))) < $2 * 86400
                 ORDER BY COALESCE(head.published_at, head.fetched_at), head.id
                 LIMIT 1
              ), n.id)
        WHERE n.id = $1
        RETURNING story_id <> id AS joined`,
      [id, SAME_STORY_DAYS],
    );
    if (row?.joined) joined++;
  }
  return { assigned: rows.length, joined };
}
