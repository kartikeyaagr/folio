/**
 * Agent 6 — news brief and exchange updates.
 *
 * **Written by itself every day at 08:00 IST, published without review, and mailed to everyone**,
 * by the fund's decision of 28-Sep-2026 (migration 0067). It had been prompted and not scheduled
 * since v3: v2 ran it at 06:30 on a cron and it was read once. The fund has now chosen a brief
 * that is already waiting over one somebody has to remember to ask for. A person can still ask
 * for one over a longer window; `sweep` below says how the two stay out of each other's way.
 *
 * **Two halves: the book, then the market.** The followed names come first, and within each one
 * filings come before press. For the SME half of this book there is no press — that is the
 * condition, not an accident — and a brief that leads with news finds nothing to say about exactly
 * the names where the exchange filings ARE the news. Ordering the input this way is the whole
 * difference between this and a press summary. Then the major stories across every outlet the
 * system polls (`mostCarried`, lib/news/stream.ts), so a morning is briefed on the market as well
 * as on the book, and a morning with no followed names still gets a brief.
 *
 * Only *confirmed* news is reported about a name. An ungated candidate has no stated mechanism, and
 * a brief built on unexplained matches is how a desk learns to stop trusting the brief. The stream
 * is different in kind: nobody claims a story in it bears on a name, so it is read as the market,
 * never attached to a name, and the prompt says so.
 */

import {
  assertInScope, raise, registerHandler, type HandlerResult, type Reads, type RunContext,
} from './runner.ts';
import { systemFor } from './prompt.ts';
import { rowId, serviceTxn, type Client } from '../db.ts';
import { IST, istHour } from '../digest.ts';
import { mostCarried, type Story } from '../news/stream.ts';

export const KEY = 'news-brief';

/**
 * The IST hour at or after which the day's brief is queued.
 *
 * Eight, by the fund's decision. An hour after `DIGEST_HOUR` and well before the 09:15 open, so a
 * brief that takes a few minutes to write is still read before the market is.
 */
export const BRIEF_HOUR = 8;

/** What the scheduled brief covers. A day, since the brief is daily; a person may ask for longer. */
export const SCHEDULED_DAYS = 1;

/**
 * Queue the day's brief, once, at or after 08:00 IST.
 *
 * **The day is the run's subject.** The scheduled run carries its IST date as `subject_ref`, so
 * this is the house's usual question, "has this subject had a run", asked with NOT EXISTS and not
 * with a watermark. A pass at 08:05 queues it. Every later pass that day finds it and queues
 * nothing, whether it is still queued, done or failed. A run that failed on the box is put back by
 * `requeueErrored`, not by a second run from here. On a box that was down at eight, the first pass
 * after it comes back still owes today's brief and queues it.
 *
 * **A brief somebody asks for is never the day's brief.** It has no `subject_ref`, so:
 *
 *   - it cannot suppress the scheduled one: asked for at 07:30, or at 08:02 before the timer's first
 *     pass after eight, the day's brief is still queued, because the day has still had no run;
 *   - it cannot duplicate it: however many are asked for, the day has one run, and
 *     `agent_runs_one_brief_a_day` (0067) holds that even when two sweeps race;
 *   - it is not a copy of it either. It covers a window from `ASKABLE_DAYS`, never the 24 hours
 *     this one does, and `askForBrief` refuses while any brief is being written, so two are never
 *     written from the same material in the same minute.
 *
 * Queuing nothing is the ordinary answer on every pass but one a day, and falls under the documented
 * exemption for agent sweeps (jobs/agents.ts).
 *
 * `now` is passed in, and one instant decides both the hour and the day, for the reason `waiting()`
 * in lib/digest.ts gives: two clocks deciding one thing disagree at midnight.
 */
export async function sweep(now = new Date()): Promise<number> {
  if (istHour(now) < BRIEF_HOUR) return 0;
  // en-CA writes a date as 2026-09-28, which is the key's whole format.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(now);
  return serviceTxn('system:agents', async (c) => {
    const { rowCount } = await c.query(
      `INSERT INTO agent_runs (id, agent_key, subject_ref, request)
       SELECT $1, a.key, $3::text, $4::jsonb
         FROM agents a
        WHERE a.key = $2 AND a.enabled
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r WHERE r.agent_key = a.key AND r.subject_ref = $3::text)
       ON CONFLICT DO NOTHING`,
      [rowId(), KEY, day, JSON.stringify({ days: SCHEDULED_DAYS })],
    );
    return rowCount ?? 0;
  });
}

// `news_sources` since 0068: the stream is defined by it, and the outlets the brief names come
// from it.
const READS = [
  'companies', 'filings', 'news_items', 'news_matches', 'news_sources', 'calendar_events', 'alerts',
];

/**
 * The most stories from the stream that enter the prompt, in `mostCarried`'s order: the most
 * widely carried first, then the newest.
 *
 * **Sized to hold a whole day, not to pick from one.** Measured 28-Sep-2026 on a live poll of all
 * 96 feeds: 1,712 stories in 24 hours (1,674 from 1,924 items in a window measured earlier), and
 * only 15 of them carried by more than one outlet — 2 by three, 13 by two. Outlets rewrite
 * headlines, and the stream merges only exact ones, so the outlet count ranks the first fifteen and
 * below that the order is recency alone. A cap of 60 would have been those fifteen and the last
 * forty minutes before eight, not the day. Only the model can see that CNBC-TV18's "Nvidia adds
 * $150 billion to existing share repurchase plan" and Bloomberg's "Nvidia Boosts Share Buyback
 * Authorization by $150 Billion" are one event, and it has to be shown both lines to do it.
 *
 * **The budget.** A day as `describe` writes it, measured the same afternoon: 1,694 lines, 127
 * characters each, 215,000 in all — about 54,000 tokens at four characters a token, or $0.27 of
 * input a morning at claude-opus-5's $5 a million, and well inside the context window beside the
 * followed names. At the cap it is 254,000 characters, about $0.32. (Characters, because counting
 * tokens needs the API; `ops/measure-prompt-cost.ts` gives the real figure.) 2,000 leaves some 17%
 * headroom over the measured day. What it bounds is the day that is not ordinary — a feed that
 * floods, a merge that stops merging — and the longer windows a person can ask for, 3 to 30 days,
 * where the cut does fall: every multi-outlet story first, then the newest of the rest. The prompt
 * says when the list is a cut.
 */
export const STREAM_CAP = 2_000;

export const SCHEMA = {
  type: 'object',
  required: ['period', 'headline', 'by_company', 'nothing_to_report', 'major_updates', 'coming_up'],
  properties: {
    period: { type: 'string' },
    headline: {
      type: 'string',
      description: 'One sentence: the most important thing in this brief, about a name or the market.',
    },
    by_company: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symbol', 'what_happened', 'why_it_matters'],
        properties: {
          symbol: { type: 'string' },
          what_happened: { type: 'array', items: { type: 'string' } },
          why_it_matters: { type: 'string' },
        },
      },
    },
    nothing_to_report: {
      type: 'array',
      description: 'Names with no filings, no news and no events. Naming them is the point.',
      items: { type: 'string' },
    },
    major_updates: {
      type: 'array',
      description: 'The major stories across the outlets, most important first. Empty only when ' +
        'no story from the outlets was given.',
      items: {
        type: 'object',
        required: ['what_happened', 'why_it_matters', 'outlets'],
        properties: {
          what_happened: { type: 'string' },
          why_it_matters: {
            type: 'string',
            description: 'Why it matters to a long-only book of Indian small and mid-cap companies.',
          },
          outlets: {
            type: 'array',
            description: 'Every outlet that ran it, written exactly as the input names them.',
            items: { type: 'string' },
          },
        },
      },
    },
    coming_up: { type: 'array', items: { type: 'string' } },
  },
} as const;

interface Material {
  symbol: string;
  name: string;
  filings: { at: string; category: string | null; summary: string | null }[];
  news: { at: string | null; title: string; source: string; mechanism: string }[];
  events: { on: string; kind: string; title: string }[];
  alerts: { severity: string; title: string }[];
}

export interface Gathered {
  names: Material[];
  /** The stream over the same window, in `mostCarried`'s order, at most `STREAM_CAP` of it. */
  stories: Story[];
  /** More stories ran in the window than `STREAM_CAP`, so `stories` is a cut and not the whole. */
  cut: boolean;
}

/**
 * Everything the brief is written from: the followed names, then the stream.
 *
 * Neither half is required. A morning with no followed names is still briefed on the market, and a
 * morning whose stream is empty is still briefed on the book, with the empty stream said out loud
 * in `describe`. Only both empty is nothing to brief on, and the handler refuses that.
 */
export async function gather(
  reads: Reads, days: number, companyId: string | null,
): Promise<Gathered> {
  const names = await reads((c) => followed(c, days, companyId));
  // Its own read-only transaction, which lib/news owns; the stream a few milliseconds after the
  // names changes nothing a brief says. One more than the cap, so a cut is known without a second
  // pass over the stream just to count it.
  const carried = await mostCarried(days * 24, STREAM_CAP + 1);
  return { names, stories: carried.slice(0, STREAM_CAP), cut: carried.length > STREAM_CAP };
}

async function followed(c: Client, days: number, companyId: string | null): Promise<Material[]> {
  const { rows: companies } = await c.query<{ id: string; symbol: string; name: string }>(
    `SELECT id, symbol, name FROM companies
      WHERE status IN ('watching','working','holding') AND removed_at IS NULL
        AND ($1::text IS NULL OR id = $1)
      ORDER BY symbol`,
    [companyId],
  );

  const out: Material[] = [];
  for (const co of companies) {
    const since = [co.id, String(days)];
    const { rows: filings } = await c.query<{ at: string; category: string | null; summary: string | null }>(
      `SELECT announced_at::text AS at, category, summary FROM filings
        WHERE company_id = $1 AND announced_at > now() - ($2 || ' days')::interval
        ORDER BY announced_at DESC`, since);
    const { rows: news } = await c.query<{ at: string | null; title: string; source: string; mechanism: string }>(
      `SELECT COALESCE(i.published_at, i.fetched_at)::text AS at, i.title, s.label AS source, m.mechanism
         FROM news_matches m
         JOIN news_items i ON i.id = m.item_id
         JOIN news_sources s ON s.key = i.source_key
        WHERE m.company_id = $1 AND m.state = 'confirmed'
          AND COALESCE(i.published_at, i.fetched_at) > now() - ($2 || ' days')::interval
        ORDER BY 1 DESC`, since);
    const { rows: events } = await c.query<{ on: string; kind: string; title: string }>(
      `SELECT on_date::text AS on, kind, title FROM calendar_events
        WHERE company_id = $1 AND on_date BETWEEN current_date AND current_date + interval '21 days'
        ORDER BY on_date`, [co.id]);
    const { rows: alerts } = await c.query<{ severity: string; title: string }>(
      `SELECT severity, title FROM alerts
        WHERE company_id = $1 AND raised_at > now() - ($2 || ' days')::interval
        ORDER BY raised_at DESC`, since);
    out.push({ symbol: co.symbol, name: co.name, filings, news, events, alerts });
  }
  return out;
}

export function describe(g: Gathered, days: number): string {
  const span = days === SCHEDULED_DAYS ? 'The last 24 hours' : `The last ${days} days`;
  const lines = [
    g.names.length === 0
      ? `${span}. No name is followed, so this brief is the stories from the outlets alone.`
      : `${span}, for every name on the book, then the stories from the outlets.`,
    '',
  ];
  for (const m of g.names) {
    lines.push(`--- ${m.name} (${m.symbol}) ---`);
    // Filings first, deliberately. For a company nobody writes about these are the only news there
    // will ever be, and a brief that reaches them last treats them as a footnote.
    lines.push('  EXCHANGE FILINGS:');
    lines.push(...(m.filings.length === 0
      ? ['    none']
      : m.filings.map((f) => `    ${f.at.slice(0, 10)}  ${f.category ?? '?'}${f.summary ? ` — ${f.summary.slice(0, 160)}` : ''}`)));
    lines.push('  ALERTS RAISED:');
    lines.push(...(m.alerts.length === 0 ? ['    none'] : m.alerts.map((a) => `    [${a.severity}] ${a.title}`)));
    lines.push('  CONFIRMED NEWS (each with the mechanism that admitted it):');
    lines.push(...(m.news.length === 0
      ? ['    none']
      : m.news.flatMap((n) => [
          `    ${(n.at ?? '').slice(0, 10)}  ${n.title}  [${n.source}]`,
          `      mechanism: ${n.mechanism}`,
        ])));
    lines.push('  SCHEDULED, NEXT THREE WEEKS:');
    lines.push(...(m.events.length === 0 ? ['    none'] : m.events.map((e) => `    ${e.on}  ${e.kind}: ${e.title}`)));
    lines.push('');
  }
  lines.push(...streamLines(g, span));
  return lines.join('\n');
}

/** An instant as `2026-09-28 07:10` in IST: the day and the minute, and no "Sept". */
const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function streamLines(g: Gathered, span: string): string[] {
  if (g.stories.length === 0) {
    // Said, not left out: a section that is simply missing reads as a quiet day. With every outlet
    // polled hourly and some 1,900 items a day, a window with none means the poll has stopped.
    return [
      'STORIES FROM THE OUTLETS:',
      `    none. No polled outlet carried a story in ${span.toLowerCase()}. That is the news ` +
        'feeds failing, not a quiet day.',
    ];
  }
  const n = g.stories.length.toLocaleString('en-IN');
  return [
    g.cut
      ? `STORIES FROM THE OUTLETS, the first ${n} by outlets and then recency; more ran and are ` +
        'not shown:'
      : `STORIES FROM THE OUTLETS, all ${n} of them:`,
    '  (most outlets first, then newest; time in IST, section, headline, [every outlet that ran it])',
    ...g.stories.map((s) =>
      // Whitespace collapsed: a headline is somebody else's text, and one carrying a newline could
      // otherwise forge a heading of this prompt's own.
      `    ${stamp.format(s.at)}  ${s.section ?? 'unfiled'}  ${s.title.replace(/\s+/g, ' ').trim()}` +
      `  [${s.outlets.join(', ')}]`),
  ];
}

/**
 * Drop every outlet a major update names that no story the brief was shown carried.
 *
 * Nobody reads the brief before everybody's inbox does, so the one claim in it that can be checked
 * mechanically is checked: an outlet named beside an update. A model filling in the outlet it
 * expects to have run a story — Reuters, which has no public feed — would otherwise be mailed as a
 * fact. What was dropped is returned and kept in the draft's `verification`.
 */
export function checkOutlets(
  content: Record<string, unknown>, stories: Story[],
): { content: Record<string, unknown>; named: number; dropped: string[] } {
  const updates = content['major_updates'];
  if (!Array.isArray(updates)) return { content, named: 0, dropped: [] };
  const carried = new Set(stories.flatMap((s) => s.outlets));
  let named = 0;
  const dropped: string[] = [];
  const checked = updates.map((u: unknown) => {
    const outlets = (u as { outlets?: unknown } | null)?.outlets;
    if (!Array.isArray(outlets)) return u;
    named += outlets.length;
    const kept = outlets.filter((o) => typeof o === 'string' && carried.has(o));
    dropped.push(...outlets.filter((o) => !kept.includes(o)).map(String));
    return { ...(u as Record<string, unknown>), outlets: kept };
  });
  return { content: { ...content, major_updates: checked }, named, dropped };
}

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);

  const days = typeof ctx.request['days'] === 'number' ? (ctx.request['days'] as number) : 7;
  const g = await gather(ctx.reads, days, ctx.companyId);
  // Either half alone is a brief. Both empty is a book nobody follows and feeds that have stopped,
  // and a brief mailed to everybody saying nothing would make that look like a quiet morning.
  if (g.names.length === 0 && g.stories.length === 0) {
    throw new Error('nothing to brief on: no name is followed, and no outlet carried a story');
  }

  const task = [
    describe(g, days),
    '',
    'Brief the desk on the above. `headline` is one sentence: the most important thing here, ' +
      'whether it is about a followed name or the market.',
    'A name with nothing under every heading goes in `nothing_to_report` — say so rather than ' +
      'finding something to say. Use only what is here; the mechanism attached to each news item ' +
      'is why it was admitted, and you may rely on it.',
    '`major_updates` are the major stories from the outlets, most important first and no more ' +
      'than ten. Most of that list is not news to this desk: choose what matters to a long-only ' +
      'book of Indian small and mid-cap companies — the economy, rates, the rupee, commodities, ' +
      'policy and regulation, sectors, listed companies, and events abroad large enough to reach ' +
      'Indian markets. Outlets rewrite headlines, so one event often appears as several lines each ' +
      'carried by one outlet: report it once and name every outlet that ran it, written exactly ' +
      'as in the brackets. A story from the outlets is not news about a followed name, even when ' +
      'it mentions one; only what appears under a name above is. If no story from the outlets was ' +
      'given, leave `major_updates` empty and say in the headline that the news feeds returned ' +
      'nothing.',
  ].join('\n');

  // Before the model call: the same line retrieval matches against and the draft stores.
  const book = g.names.length === 0
    ? 'no followed names'
    : `across ${g.names.length} followed names: ` +
      `${g.names.reduce((n, m) => n + m.filings.length, 0)} filings, ` +
      `${g.names.reduce((n, m) => n + m.news.length, 0)} news items, ` +
      `${g.names.reduce((n, m) => n + m.alerts.length, 0)} alerts`;
  const market = g.stories.length === 0
    ? 'no story from any outlet'
    : `${g.stories.length}${g.cut ? ' (a cut)' : ''} stories from the outlets`;
  const situation = `${days}-day desk brief ${book}; ${market}`;

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'xhigh') as 'xhigh',
    system: await systemFor(ctx.agent, situation),
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);
  const { content, named, dropped } = checkOutlets(answer.content, g.stories);

  return {
    draft: {
      content,
      // A quiet week over three names and a heavy week over twelve are different jobs, and the
      // counts are what says which this was.
      situation,
      sources: [
        ...g.names.map((m) => ({
          kind: 'company', symbol: m.symbol,
          filings: m.filings.length, news: m.news.length, events: m.events.length,
          alerts: m.alerts.length,
        })),
        { kind: 'stream', hours: days * 24, stories: g.stories.length, cut: g.cut },
      ],
      verification: {
        // Null when no outlet was named: nothing was checked, and `true` would claim it had been.
        agreed: named === 0 ? null : dropped.length === 0,
        dropped_outlets: dropped,
        note: 'News about a followed name was confirmed by the news gate. The major updates come ' +
          'from the stream, which nothing gates or scores; the outlets named beside them were ' +
          'checked against the stories this brief was given' +
          (dropped.length === 0
            ? '.'
            : `, and ${dropped.length} that ran none of them ${dropped.length === 1 ? 'was' : 'were'} ` +
              `dropped: ${dropped.join(', ')}.`),
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});
