/**
 * Reading RSS and Atom.
 *
 * Hand-written, for the same reason SMTP is: this is one well-specified format read from a fixed
 * list of feeds, and the alternative is a parser dependency with a transitive tree for about a
 * hundred lines that have not needed to change since 2005. What it must handle is real and narrow:
 * both formats in one function, CDATA, HTML entities, and the four different spellings publishers
 * use for "when".
 */

import { decodeHTML } from 'entities';

/**
 * One entry, from either format.
 *
 * `guid` identifies the item **within its own feed and nowhere else**: it is the publisher's
 * `<guid>` or Atom `<id>` where there is one and the article's own URL where there is not, and
 * neither is unique across publishers — a wire story picked up by three outlets can arrive under
 * one id in all three. `poll.ts` keys `news_items` on `(source_key, guid)` and hashes both
 * together for the row id for exactly that reason. Treating `guid` alone as the key merges two
 * publishers' rows into one and loses whichever arrived second.
 *
 * `publishedAt` is ISO-8601 UTC or null, and null is ordinary rather than exceptional — PIB's feed
 * carries no dates and no guids at all (`tasks/measured-traps.md`, News). Anything ordering by
 * time has to decide what to do with those; `news_items` falls back to `fetched_at`, and so does
 * `match.ts`'s same-story window.
 */
export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  summary: string | null;
  publishedAt: string | null;
}

export class NotAFeed extends Error {}

/**
 * CDATA out, entities in.
 *
 * The named entities were a table of thirteen until 18-Sep-2026. Numeric references were already
 * general, so what fell through were the named ones HTML5 defines and this table did not — and
 * the fallthrough returned the reference verbatim, so `&rsquo;` and `&hellip;` were stored into
 * `news_items.title` as themselves and rendered to a reader that way. Indian business press uses
 * both heavily. `entities` carries the whole HTML5 table, has no dependencies, and is by the
 * author of the parser `fast-xml-parser` competes with.
 */
function decode(text: string): string {
  return decodeHTML(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

/**
 * Strip markup from a title or summary. Publishers put whole articles, images and trackers there.
 *
 * **A tag, not merely a pair of angle brackets.** This stripped `<[^>]*>` until 21-Sep-2026, and
 * because entities are decoded first — they have to be, since publishers routinely escape their
 * markup as `&lt;p&gt;` and the existing test pins that — a headline's own `&lt;` had already
 * become a real `<` by the time the regex ran. Any later `&gt;` closed the imaginary tag and
 * everything between them was deleted, silently, on the two fields that matter most: the
 * headline is what `match.ts` runs over and what the desk reads.
 *
 *   before:  "Praj PAT &lt; estimates, guidance &gt; consensus"  ->  "Praj PAT consensus"
 *   before:  "Revenue &lt; 500 crore &gt; last year"             ->  "Revenue last year"
 *
 * Requiring a tag name after the bracket separates the two cases, because `< estimates` opens
 * with a space and `<p` does not. The genuinely ambiguous input — a comparison written with no
 * space, `PAT <estimates>` — is indistinguishable from markup by anything short of a parser, and
 * is left to be stripped.
 */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/gi;
const plain = (html: string): string =>
  decode(html).replace(TAG, ' ').replace(/\s+/g, ' ').trim();

function tag(block: string, ...names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    if (m) {
      const v = decode(m[1]!);
      if (v) return v;
    }
  }
  return null;
}

/** Atom puts the link in an attribute rather than in the element. */
function atomLink(block: string): string | null {
  const alternate = /<link[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(block)
    ?? /<link[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i.exec(block)
    ?? /<link[^>]*\bhref=["']([^"']+)["']/i.exec(block);
  return alternate ? decode(alternate[1]!) : null;
}

/**
 * A date, or nothing.
 *
 * Publishers use RFC 822, ISO 8601, and several things that are neither. A headline with no date is
 * still a headline, so an unreadable one is null rather than a dropped item — but a *fabricated*
 * date would put a story in the wrong place on a page that is ordered by time.
 */
export function feedDate(value: string | null): string | null {
  if (!value) return null;
  // SEBI writes "07 Sep, 2026 +0530", which Date.parse rejects outright: the comma defeats it, and
  // so does an offset with no time of day behind it. Both are repaired rather than dropped —
  // dropping the offset instead would parse the date in the host's timezone, which is right on the
  // VM and wrong everywhere else.
  const cleaned = value.trim().replace(/,/g, '')
    .replace(/^(.*\d{4})\s+([+-]\d{4}|Z)$/, '$1 00:00:00 $2');
  const t = Date.parse(cleaned);
  if (Number.isNaN(t)) return null;
  // A feed that claims a story from 2035 is a broken feed, not a scoop.
  const at = new Date(t);
  if (at.getUTCFullYear() < 1995 || t > Date.now() + 7 * 86_400_000) return null;
  return at.toISOString();
}

/**
 * Every usable entry in an RSS or Atom document.
 *
 * **Three outcomes, and a caller has to tell them apart.** A document that is not a feed at all —
 * the 200-with-an-HTML-error-page a moved or blocked URL serves — throws `NotAFeed`. A real feed
 * root carrying no entries returns `[]`, and that is not a quiet day: `pollOne` records it as a
 * failed feed, because a publisher's feed is never legitimately empty and an empty one means the
 * URL now points somewhere else. That is lesson L1, whose clearest instance is the NSE insider
 * endpoint: zero rows at HTTP 200, which v2 reported as "0 disclosure(s) in the window" every run.
 *
 * An entry missing either a link or a title is dropped without comment, so the length returned can
 * be smaller than the number of `<item>` elements in the document. What comes back is entries
 * something can be done with, not a count of what the publisher sent.
 *
 * `<item>` and `<entry>` are collected in one pass rather than by deciding the format from the
 * root element; the root is examined only to tell a broken response from an empty feed, and
 * `rdf:RDF` counts as a feed root alongside `rss` and `feed`.
 *
 * The failure this does **not** catch is L23's: a feed that answers with a full, stale history.
 * Nothing here looks at how old the newest entry is, and nothing downstream does either.
 */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  if (blocks.length === 0) {
    // Distinguished from "a quiet feed": a document with no channel and no feed root is not a feed
    // at all, which is what a 200-with-an-HTML-error-page looks like.
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new NotAFeed('not an RSS or Atom document');
    return [];
  }

  const items: FeedItem[] = [];
  for (const m of blocks) {
    const block = m[1]!;
    const url = tag(block, 'link') ?? atomLink(block);
    const title = tag(block, 'title');
    if (!url || !title) continue;

    const summary = tag(block, 'description', 'summary', 'content:encoded', 'content');
    items.push({
      // guid, then id, then the link. The link is stable enough to deduplicate on for a publisher
      // that offers nothing better, which several do.
      guid: tag(block, 'guid', 'id') ?? url,
      url,
      title: plain(title),
      summary: summary ? plain(summary).slice(0, 2000) || null : null,
      publishedAt: feedDate(tag(block, 'pubDate', 'published', 'updated', 'dc:date')),
    });
  }
  return items;
}
