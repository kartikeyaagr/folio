/**
 * Agent 3 — analyse a company from scratch.
 *
 * Prompted, because a dossier is something you ask for when you are about to do work on a name.
 *
 * The design problem here is not summarising; it is **not sounding complete**. Everything this
 * agent reads is thin on a company nobody has researched yet, and a fluent dossier over an empty
 * record is actively dangerous — it reads like knowledge. So the prompt states what is held and
 * what is *not* held, item by item, and the schema forces the model to list the gaps as gaps.
 *
 * It does not touch the forensic checklist. That belongs to agent 7, and twelve careful checks
 * folded into a section become a paragraph.
 */

import { assertInScope, raise, registerHandler, type HandlerResult, type RunContext } from './runner.ts';
import { type Client } from '../db.ts';

export const KEY = 'company-dossier';

const READS = [
  'companies', 'filings', 'fundamentals', 'documents', 'document_versions',
  'insider_transactions', 'shareholding_patterns', 'prices', 'holdings',
];

const SCHEMA = {
  type: 'object',
  required: ['business', 'financial_history', 'ownership', 'recent_events', 'open_questions', 'gaps'],
  properties: {
    business: { type: 'string', description: 'What the company does, from what is held. Say so if that is little.' },
    financial_history: { type: 'string', description: 'What the reported numbers have done, and over how long.' },
    ownership: { type: 'string', description: 'Promoter holding, encumbrance, institutional holding, insider activity.' },
    recent_events: { type: 'array', items: { type: 'string' } },
    open_questions: {
      type: 'array',
      description: 'What someone would have to find out before taking a position.',
      items: { type: 'string' },
    },
    gaps: {
      type: 'array',
      description: 'What the system does not hold, named plainly. This is not optional padding.',
      items: { type: 'string' },
    },
  },
} as const;

const CRORE = 10_000_000;
const cr = (v: string | null): string => (v === null ? 'not reported' : `${(Number(v) / CRORE).toFixed(1)} cr`);

interface Held {
  company: { symbol: string; name: string; sector: string | null; status: string; isin: string | null };
  quarters: { period_start: string; period_end: string; basis: string; revenue: string | null; profit_after_tax: string | null }[];
  filings: { announced_at: string; category: string | null; summary: string | null }[];
  insider: { disclosed_at: string; person: string; category: string | null; kind: string | null; quantity: string | null; pct_before: string | null; pct_after: string | null }[];
  shareholding: { as_of: string; promoter_pct: string | null; promoter_pledge_pct: string | null; promoter_encumbered_pct: string | null; fii_pct: string | null; dii_pct: string | null }[];
  notes: { title: string; kind: string; summary: string | null }[];
  held: { qty: string; avg_cost: string } | null;
}

async function gather(c: Client, companyId: string): Promise<Held | null> {
  const one = async <T extends Record<string, unknown>>(
    sql: string, params: unknown[] = [companyId],
  ): Promise<T[]> => (await c.query<T>(sql, params)).rows;

  const [company] = await one<Held['company']>(
    'SELECT symbol, name, sector, status, isin FROM companies WHERE id = $1',
  );
  if (!company) return null;

  return {
    company,
    quarters: await one(
      `SELECT period_start, period_end, basis, revenue::text, profit_after_tax::text
         FROM fundamentals WHERE company_id = $1 AND superseded_by IS NULL
        ORDER BY period_end DESC LIMIT 12`,
    ),
    filings: await one(
      `SELECT announced_at::text, category, summary FROM filings
        WHERE company_id = $1 ORDER BY announced_at DESC LIMIT 25`,
    ),
    insider: await one(
      `SELECT disclosed_at::text, person, category, kind, quantity::text, pct_before::text, pct_after::text
         FROM insider_transactions WHERE company_id = $1
        ORDER BY disclosed_at DESC LIMIT 20`,
    ),
    shareholding: await one(
      `SELECT as_of::text, promoter_pct::text, promoter_pledge_pct::text,
              promoter_encumbered_pct::text, fii_pct::text, dii_pct::text
         FROM shareholding_patterns WHERE company_id = $1 ORDER BY as_of DESC LIMIT 8`,
    ),
    notes: await one(
      `SELECT d.title, d.kind,
              (SELECT summary FROM document_versions v WHERE v.document_id = d.id
                ORDER BY written_at DESC LIMIT 1) AS summary
         FROM documents d
        WHERE d.company_id = $1 AND d.archived_at IS NULL AND d.kind <> 'transcript'
        ORDER BY d.updated_at DESC LIMIT 15`,
    ),
    held: (await one<{ qty: string; avg_cost: string }>(
      'SELECT quantity::text AS qty, avg_cost::text AS avg_cost FROM holdings WHERE company_id = $1',
    ))[0] ?? null,
  };
}

/**
 * The record, written out including what is missing.
 *
 * Every section that has nothing says "none held" rather than being omitted. An absent section
 * reads as an oversight; a section saying nothing is held is a fact the model has to work with.
 */
export function describe(h: Held): string {
  const lines: string[] = [
    `${h.company.name} (${h.company.symbol})`,
    `Status on the book: ${h.company.status}${h.held ? ` — holding ${h.held.qty} at an average cost of ${h.held.avg_cost}` : ''}`,
    h.company.sector ? `Sector: ${h.company.sector}` : 'Sector: not set',
    '',
    'REPORTED PERIODS:',
    ...(h.quarters.length === 0
      ? ['  none held — no results have been parsed for this company']
      : h.quarters.map((q) =>
          `  ${q.period_start}..${q.period_end} (${q.basis})  revenue ${cr(q.revenue)}  PAT ${cr(q.profit_after_tax)}`)),
    '',
    'SHAREHOLDING:',
    ...(h.shareholding.length === 0
      ? ['  none held']
      : h.shareholding.map((s) =>
          `  ${s.as_of}  promoter ${s.promoter_pct ?? '?'}%  pledged ${s.promoter_pledge_pct ?? 'not disclosed'}%` +
          `  encumbered ${s.promoter_encumbered_pct ?? 'not disclosed'}%  FII ${s.fii_pct ?? '?'}%  DII ${s.dii_pct ?? '?'}%`)),
    '  (pledge and encumbrance are percentages OF THE PROMOTER HOLDING, not of the company)',
    '',
    'INSIDER AND PLEDGE DISCLOSURES:',
    ...(h.insider.length === 0
      ? ['  none held']
      : h.insider.map((i) =>
          `  ${i.disclosed_at.slice(0, 10)}  ${i.category ?? '?'} ${i.kind ?? '?'} ${i.quantity ?? '?'}` +
          `  ${i.pct_before ?? '?'}% -> ${i.pct_after ?? '?'}%  (${i.person})`)),
    '',
    'EXCHANGE FILINGS:',
    ...(h.filings.length === 0
      ? ['  none held']
      : h.filings.map((f) => `  ${f.announced_at.slice(0, 10)}  ${f.category ?? '?'}${f.summary ? ` — ${f.summary.slice(0, 140)}` : ''}`)),
    '',
    'DOCUMENTS THE DESK HAS WRITTEN:',
    ...(h.notes.length === 0
      ? ['  none — nobody here has written anything on this company yet']
      : h.notes.map((n) => `  [${n.kind}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 200)}` : ''}`)),
  ];
  return lines.join('\n');
}

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);
  if (!ctx.companyId) throw new Error('company-dossier needs a company');

  const held = await gather(ctx.c, ctx.companyId);
  if (!held) throw new Error(`no company ${ctx.companyId}`);

  const task = [
    'Everything the system holds on this company follows. It may be very little.',
    '',
    describe(held),
    '',
    'Write the dossier from this and nothing else. Do not supply facts about the company from ',
    'general knowledge — if the record does not contain it, it belongs in `gaps`. A section with ',
    'nothing behind it should say so in one line rather than being filled out.',
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
      sources: [
        { kind: 'company', ref: ctx.companyId },
        { kind: 'fundamentals', count: held.quarters.length },
        { kind: 'filings', count: held.filings.length },
        { kind: 'insider_transactions', count: held.insider.length },
        { kind: 'shareholding_patterns', count: held.shareholding.length },
        { kind: 'documents', count: held.notes.length },
      ],
      verification: {
        agreed: null,
        note: 'No deterministic check applies. The counts above are what the dossier was built from ' +
          'and are the reviewer\'s check on whether it claims more than the record holds.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});
