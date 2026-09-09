/**
 * The wide net: turning headlines into candidates.
 *
 * v2 built a five-layer heuristic stack here — a feed-share cap, a trade-show filter, a market
 * anchor, sector tagging and transmission phrases — and measured the result at 58.8% precision,
 * up from 31%. Every one of those layers exists because the alternative was showing the desk a
 * story that had nothing to do with the company.
 *
 * v3 keeps the net and throws away the stack. Nothing here decides whether a story is *about* a
 * company; it decides whether a story is worth **asking** about. The gate answers, and it answers
 * by stating the mechanism or dropping the candidate. That is the trade: one model call per
 * candidate in exchange for five heuristics that each needed their own corpus to calibrate.
 *
 * What survives from the stack, because it is not a heuristic:
 *
 *   * **Word boundaries.** "Ecos" must not match "ecosystem" and "Sagar" must not match
 *     "Sagarmala". A length floor was tried instead and silently dropped Praj and Tega — two names
 *     on an eleven-name book — because Indian company names are frequently four letters.
 *   * **A stoplist** for distinctive tokens that are also ordinary words. "Supreme", "Prime" and
 *     "Union" appear in prose about something else every day, and no boundary check helps there.
 *   * **The market anchor, moved to where it belongs.** v2 asked the *headline* whether it
 *     mentioned India; 71 of 135 items from Indian trade titles never do, which cost two real
 *     PRAJIND stories. The source knows its own market, so the source is asked.
 *
 * One story yields one candidate even when several feeds carry it. That is deduplication by exact
 * identity — the article's own URL, or its headline character for character — and not the
 * clustering that was declined: clustering groups things that are *about* the same subject and was
 * measured as doing nothing, while this collapses rows that are the same article.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';

/** Four, not five. A floor of five excludes Praj and Tega. Boundaries do the real work. */
const MIN_TERM_CHARS = 4;

/** Words a name can reduce to that are ordinary prose. */
const STOPLIST = new Set([
  'best', 'first', 'great', 'ideal', 'modern', 'national', 'onward', 'premier', 'prime', 'quality',
  'star', 'sun', 'supreme', 'trust', 'union', 'united', 'universal', 'western',
]);

/** The parts of a company name that identify nobody. */
const FURNITURE = new Set([
  'limited', 'ltd', 'private', 'pvt', 'public', 'company', 'co', 'corporation', 'corp',
  'industries', 'industry', 'enterprises', 'holdings', 'group', 'india', 'technologies',
  'technology', 'solutions', 'services', 'systems', 'international', 'global', 'and', 'the', 'of',
]);

/**
 * The part of a name that identifies it.
 *
 * "Tega Industries Limited" becomes "Tega". "Ecos (India) Mobility & Hospitality Limited" becomes
 * "Mobility Hospitality", which is why the stoplist matters more than the stripping does.
 */
export function distinctive(name: string): string {
  return name
    .replace(/[(),.&]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FURNITURE.has(w.toLowerCase()))
    .join(' ')
    .trim();
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-bounded at both ends, case-insensitive. The boundary is the whole safety property. */
export function mentions(haystack: string, term: string): boolean {
  if (term.length < MIN_TERM_CHARS) return false;
  return new RegExp(`\\b${escape(term)}\\b`, 'i').test(haystack);
}

/**
 * Vocabulary is bounded at the front only.
 *
 * A closing boundary would mean "sugar mill" misses "sugar mills" and "distillery" misses
 * "distilleries" — and stories are written in the plural far more often than the singular. The
 * leading boundary is what still stops a term matching inside a longer word.
 */
export function mentionsTerm(haystack: string, term: string): boolean {
  return new RegExp(`\\b${escape(term)}`, 'i').test(haystack);
}

/**
 * The phrase that stands for a company name.
 *
 * One distinctive word is used alone; two or more become the **first two, adjacent**. Matching a
 * multi-word name on its first word alone is what filed a Sterling Wilson story under Sterling
 * Tools — "Sterling" identifies a dozen companies, "Sterling Tools" identifies one. Whitespace is
 * loose because headlines break lines wherever they like.
 */
export function nameTerm(name: string): { term: string; pattern: RegExp } | null {
  const tokens = distinctive(name).split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const only = tokens[0]!;
    if (only.length < MIN_TERM_CHARS || STOPLIST.has(only.toLowerCase())) return null;
    return { term: only, pattern: new RegExp(`\\b${escape(only)}\\b`, 'i') };
  }
  if (tokens.length >= 2) {
    const pair = tokens.slice(0, 2);
    return {
      term: pair.join(' '),
      pattern: new RegExp(`\\b${pair.map(escape).join('\\s+')}\\b`, 'i'),
    };
  }
  return null;
}

export type Tier = 'symbol' | 'isin' | 'name' | 'alias' | 'subsidiary' | 'brand' | 'sector_term';

export interface CompanyVocabulary {
  id: string;
  symbol: string;
  isin: string | null;
  name: string;
  sector: string | null;
  aliases: { alias: string; kind: string }[];
  sectorTerms: string[];
}

export interface Item {
  id: string;
  title: string;
  summary: string | null;
  sourceSector: string | null;
  sourceMarket: string;
}

export interface Candidate {
  itemId: string;
  companyId: string;
  tier: Tier;
  evidence: string;
}

const ALIAS_TIER: Record<string, Tier> = {
  name: 'alias', former_name: 'alias', abbreviation: 'alias',
  subsidiary: 'subsidiary', brand: 'brand',
};

/**
 * Everything the net catches, at the narrowest tier that catches it.
 *
 * A story caught by both the company's name and a sector term is a name match. The tier is what the
 * gate is told, and telling it "sector term" when the story names the company outright would make
 * it work harder for a worse answer.
 */
export function candidatesFor(item: Item, companies: CompanyVocabulary[]): Candidate[] {
  const text = `${item.title} ${item.summary ?? ''}`;
  const out: Candidate[] = [];

  for (const co of companies) {
    const at = (tier: Tier, evidence: string): Candidate =>
      ({ itemId: item.id, companyId: co.id, tier, evidence });

    // Identifiers, in order of how certainly they name this company and nothing else.
    if (co.symbol.length >= MIN_TERM_CHARS && new RegExp(`\\b${escape(co.symbol)}\\b`).test(text)) {
      // Upper case as written: a ticker in prose is capitalised, and the same letters in lower
      // case are usually a word.
      out.push(at('symbol', co.symbol));
      continue;
    }
    if (co.isin && text.includes(co.isin)) { out.push(at('isin', co.isin)); continue; }

    const named = nameTerm(co.name);
    if (named && named.pattern.test(text)) { out.push(at('name', named.term)); continue; }

    const alias = co.aliases.find(
      (a) => !STOPLIST.has(a.alias.toLowerCase()) && mentions(text, a.alias),
    );
    if (alias) { out.push(at(ALIAS_TIER[alias.kind] ?? 'alias', alias.alias)); continue; }

    // Vocabulary. Two conditions, both about the source rather than the story.
    if (!co.sector) continue;
    // The source's own market, not the story's wording. This is the fix for the two ChiniMandi
    // sugar-mill reports v2 lost: 71 of 135 items from Indian trade titles never write "India".
    if (item.sourceMarket !== 'india') continue;
    // A general title is about everything; a trade title is about one industry. Admitting a
    // bioenergy term from a mining feed is admitting a coincidence.
    if (item.sourceSector !== null && item.sourceSector !== co.sector) continue;

    // Nothing here asks whether the story names a company. A first version did, on the theory that
    // "sugar output rises 3% in Maharashtra" gives the gate nothing to work with. Measured against
    // 2,084 real items it removed five of six candidates, and the five were revised CBG pricing,
    // two ethanol-policy stories and the economics of integrated sugar-ethanol projects — policy
    // that moves the market this company sells into, which is the most valuable thing this tier
    // finds and exactly what v2 lost. The gate decides; the net does not get to be clever.

    const term = co.sectorTerms.find((t) => mentionsTerm(text, t));
    if (term) out.push(at('sector_term', term));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Persistence
// ------------------------------------------------------------------------------------------------

const matchId = (itemId: string, companyId: string): string =>
  createHash('sha256').update(`${itemId} ${companyId}`).digest('hex').slice(0, 32);

export async function loadVocabulary(): Promise<CompanyVocabulary[]> {
  return serviceTxn('system:news', async (c) => {
    const { rows } = await c.query<CompanyVocabulary>(
      `SELECT co.id, co.symbol, co.isin, co.name, co.sector,
              COALESCE(
                (SELECT json_agg(json_build_object('alias', a.alias, 'kind', a.kind))
                   FROM company_aliases a WHERE a.company_id = co.id), '[]'
              ) AS aliases,
              COALESCE(
                (SELECT json_agg(t.term) FROM sector_terms t WHERE t.sector = co.sector), '[]'
              ) AS "sectorTerms"
         FROM companies co
        WHERE co.status <> 'passed'`,
    );
    return rows;
  });
}

export interface MatchResult {
  items: number;
  candidates: number;
  /** Items that were the same story as one already matched for that company. */
  duplicates: number;
}

/**
 * How far apart two carriers of one story may be.
 *
 * Seven days, from measurement rather than taste: the widest genuine gap in 2,089 real items was
 * three (Manufacturing Dive on the 1st, Supply Chain Dive on the 4th, one Chobani story). A window
 * at all is what stops a column that runs under the same headline every week from collapsing into
 * a single row forever.
 */
export const SAME_STORY_DAYS = 7;

/**
 * Match every item that has not been matched yet.
 *
 * Asks what has no match row rather than what arrived recently — the same rule as the alert
 * evaluator, for the same reason: a window can only lose things, and a story that arrived while a
 * company was being added would fall through one.
 */
export async function matchNewItems(limit = 2000): Promise<MatchResult> {
  const companies = await loadVocabulary();
  if (companies.length === 0) return { items: 0, candidates: 0, duplicates: 0 };

  return serviceTxn('system:news', async (c) => {
    const { rows: items } = await c.query<Item>(
      `SELECT i.id, i.title, i.summary,
              s.sector AS "sourceSector", s.market AS "sourceMarket"
         FROM news_items i
         JOIN news_sources s ON s.key = i.source_key
        -- A source that has been switched off contributes nothing, including what it already
        -- fetched. Without this the question below — which asks what has no match row, and so has
        -- no window to fall out of — would go on matching and gating a retired feed's backlog for
        -- as long as the rows exist. Turning a feed off has to mean off.
        WHERE s.active
          AND NOT EXISTS (SELECT 1 FROM news_matches m WHERE m.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM news_matched_items d WHERE d.item_id = i.id)
        ORDER BY i.fetched_at
        LIMIT $1`,
      [limit],
    );

    let candidates = 0;
    let duplicates = 0;
    for (const item of items) {
      for (const cand of candidatesFor(item, companies)) {
        // One story, one candidate. Two feeds carrying the same article would otherwise be judged
        // twice — two model calls to reach the same answer — and then shown to the reader twice.
        // Exact equality on the article's own address or its headline, never similarity.
        const { rows: already } = await c.query<{ id: string }>(
          `SELECT m.id
             FROM news_matches m
             JOIN news_items other ON other.id = m.item_id
             JOIN news_items this ON this.id = $1
            WHERE m.company_id = $2
              AND m.item_id <> $1
              AND (other.url_key = this.url_key
                   OR (other.title_key IS NOT NULL AND other.title_key = this.title_key))
              AND abs(extract(epoch FROM
                    COALESCE(other.published_at, other.fetched_at)
                  - COALESCE(this.published_at, this.fetched_at))) < $3 * 86400
            LIMIT 1`,
          [cand.itemId, cand.companyId, String(SAME_STORY_DAYS)],
        );
        if (already[0]) { duplicates++; continue; }

        await c.query(
          `INSERT INTO news_matches (id, item_id, company_id, tier, evidence)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (item_id, company_id) DO NOTHING`,
          [matchId(cand.itemId, cand.companyId), cand.itemId, cand.companyId, cand.tier, cand.evidence],
        );
        candidates++;
      }
      // An item that matched nothing is recorded as looked-at, so the next run does not
      // re-examine every headline the system has ever seen.
      await c.query(
        'INSERT INTO news_matched_items (item_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [item.id],
      );
    }
    return { items: items.length, candidates, duplicates };
  });
}
