/**
 * Agent 6 — news brief and exchange updates.
 *
 * **Written by itself every day at 08:00 IST, published without review, and mailed to everyone**,
 * by the fund's decision of 28-Sep-2026 (migration 0067). It had been prompted and not scheduled
 * since v3: v2 ran it at 06:30 on a cron and it was read once. The fund has now chosen a brief
 * that is already waiting over one somebody has to remember to ask for. A person can still ask
 * for one over a longer window; `sweep` below says how the two stay out of each other's way.
 *
 * **Filings first, then press.** For the SME half of this book there is no press — that is the
 * condition, not an accident — and a brief that leads with news finds nothing to say about exactly
 * the names where the exchange filings ARE the news. Ordering the input this way is the whole
 * difference between this and a press summary.
 *
 * Only *confirmed* news reaches it. An ungated candidate has no stated mechanism, and a brief built
 * on unexplained matches is how a desk learns to stop trusting the brief.
 */

import { assertInScope, raise, registerHandler, type HandlerResult, type RunContext } from './runner.ts';
import { systemFor } from './prompt.ts';
import { rowId, serviceTxn, type Client } from '../db.ts';
import { IST, istHour } from '../digest.ts';

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

const READS = ['companies', 'filings', 'news_items', 'news_matches', 'calendar_events', 'alerts'];

export const SCHEMA = {
  type: 'object',
  required: ['period', 'by_company', 'nothing_to_report', 'coming_up'],
  properties: {
    period: { type: 'string' },
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

export async function gather(c: Client, days: number, companyId: string | null): Promise<Material[]> {
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

export function describe(material: Material[], days: number): string {
  const span = days === SCHEDULED_DAYS ? 'The last 24 hours' : `The last ${days} days`;
  const lines = [`${span}, for every name on the book.`, ''];
  for (const m of material) {
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
  return lines.join('\n');
}

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);

  const days = typeof ctx.request['days'] === 'number' ? (ctx.request['days'] as number) : 7;
  const material = await ctx.reads((c) => gather(c, days, ctx.companyId));
  if (material.length === 0) throw new Error('no companies to brief on');

  const task = [
    describe(material, days),
    'Brief the desk on the above. A name with nothing under every heading goes in ' +
      '`nothing_to_report` — say so rather than finding something to say. Use only what is here; ' +
      'the mechanism attached to each news item is why it was admitted, and you may rely on it.',
  ].join('\n');

  // Before the model call: the same line retrieval matches against and the draft stores.
  const situation =
    `${days}-day desk brief across ${material.length} followed names: ` +
    `${material.reduce((n, m) => n + m.filings.length, 0)} filings, ` +
    `${material.reduce((n, m) => n + m.news.length, 0)} news items, ` +
    `${material.reduce((n, m) => n + m.alerts.length, 0)} alerts`;

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'xhigh') as 'xhigh',
    system: await systemFor(ctx.agent, situation),
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);

  return {
    draft: {
      content: answer.content,
      // A quiet week over three names and a heavy week over twelve are different jobs, and the
      // counts are what says which this was.
      situation,
      sources: material.map((m) => ({
        kind: 'company', symbol: m.symbol,
        filings: m.filings.length, news: m.news.length, events: m.events.length, alerts: m.alerts.length,
      })),
      verification: {
        agreed: null,
        note: 'No automatic check applies. Every news item in this brief was confirmed by the ' +
          'news gate.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});
