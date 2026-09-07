/**
 * Reading RSS and Atom.
 *
 * Hand-written, for the same reason SMTP is: this is one well-specified format read from a fixed
 * list of feeds, and the alternative is a parser dependency with a transitive tree for about a
 * hundred lines that have not needed to change since 2005. What it must handle is real and narrow:
 * both formats in one function, CDATA, HTML entities, and the four different spellings publishers
 * use for "when".
 */

export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  summary: string | null;
  publishedAt: string | null;
}

export class NotAFeed extends Error {}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#8217': '’',
  '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—',
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return whole;
    })
    .trim();
}

/** Strip markup from a summary. Publishers put whole articles, images and trackers in there. */
const plain = (html: string): string =>
  decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

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
