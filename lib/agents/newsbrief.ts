/**
 * Agent 6 — news brief and exchange updates.
 *
 * Prompted, not scheduled. v2 ran this at 06:30 on a cron and it was read once; a brief that
 * arrives whether or not anybody wants it becomes something to dismiss rather than something to
 * read.
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
import { type Client } from '../db.ts';

export const KEY = 'news-brief';

const READS = ['companies', 'filings', 'news_items', 'news_matches', 'calendar_events', 'alerts'];

const SCHEMA = {
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
      WHERE status IN ('watching','working','holding') AND ($1::text IS NULL OR id = $1)
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
  const lines = [`The last ${days} days, for every name on the book.`, ''];
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

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'xhigh') as 'xhigh',
    system: ctx.agent.purpose,
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);

  return {
    draft: {
      content: answer.content,
      // A quiet week over three names and a heavy week over twelve are different jobs, and the
      // counts are what says which this was.
      situation:
        `${days}-day desk brief across ${material.length} followed names: ` +
        `${material.reduce((n, m) => n + m.filings.length, 0)} filings, ` +
        `${material.reduce((n, m) => n + m.news.length, 0)} news items, ` +
        `${material.reduce((n, m) => n + m.alerts.length, 0)} alerts`,
      sources: material.map((m) => ({
        kind: 'company', symbol: m.symbol,
        filings: m.filings.length, news: m.news.length, events: m.events.length, alerts: m.alerts.length,
      })),
      verification: {
        agreed: null,
        note: 'No deterministic check applies. Every news item behind this brief passed the ' +
          'mechanism gate; no ungated candidate was supplied.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});
