/**
 * Poll the feeds and cast the net.
 *
 * Polling and matching run together because they are one thought: a headline nobody has looked at
 * yet is not news. Splitting them into two timers would only create a window in which the system
 * holds a story and has not considered it.
 *
 *   pnpm exec tsx jobs/news-poll.ts
 */
import './_env.ts';

import { pollFeeds } from '../lib/news/poll.ts';
import { matchNewItems } from '../lib/news/match.ts';
import { runJob } from './_run.ts';

await runJob('news_poll', async () => {
  const poll = await pollFeeds();
  // Every feed failing is a network or DNS problem. One feed failing is a fact about that feed,
  // and it is recorded on the feed's own row rather than drowned in a total.
  if (poll.feeds > 0 && poll.ok === 0) {
    throw new Error(`all ${poll.feeds} feeds failed: ${poll.failures[0]?.error ?? 'unknown'}`);
  }
  const match = await matchNewItems();
  const detail =
    `${poll.ok}/${poll.feeds} feeds, ${poll.stored} new items, ` +
    `${match.candidates} candidates from ${match.items} examined` +
    (poll.failures.length > 0 ? `; failing: ${poll.failures.map((f) => f.key).join(', ')}` : '');
  return { items: poll.stored, detail };
});
