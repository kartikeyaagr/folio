/**
 * `get_position` — what the fund owns in one name, and what it paid.
 *
 * Delegates to `lib/book.ts`'s `holdings()`, whose SQL reads `holdings`, `companies` and `prices`.
 * It returns the whole book and is filtered here rather than in SQL, because it is the only query
 * in the tree that carries a mark and its LEFT JOIN LATERAL on the latest close is the part worth
 * not forking — a holding with no price row must appear unmarked rather than vanish.
 *
 * **This tool reads the book and nothing can write to it.** `v4.md §6.2` drops v2's schema
 * constraint excluding `positions`/`transactions`/`tax_lots`/`cash_ledger` from an agent's scope,
 * because "what do we own in this and what did it cost" is one of the obvious reasons to open a
 * chat — and replaces it with a weaker rule that is enforced somewhere better: the ledger's three
 * write paths stay in a person's hands, and every tool runs on a `BEGIN READ ONLY` transaction.
 * A review gate on `ai_drafts` would not protect a `transactions` row, because a trade is not a
 * draft; a read-only transaction does.
 */

import { holdings } from '../../book.ts';
import { betaTool, resolveSubject, served, type ToolContext, type ToolSpec } from './spec.ts';

export const spec: ToolSpec = {
  name: 'get_position',
  reads: ['holdings', 'companies', 'prices'],
  build: (ctx: ToolContext) =>
    betaTool({
      name: 'get_position',
      description:
        'What the fund holds in one company: quantity, average cost, total cost, the latest close ' +
        'held and the market value at it. Says plainly when the fund holds none. This is the ' +
        'book as recorded; it cannot be changed from here.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', description: 'Exchange symbol. Required unless the run already names a company.' },
        },
      },
      run: (args) =>
        served(ctx, 'get_position', args as unknown as Record<string, unknown>, async () => {
          const found = await resolveSubject(ctx, args.symbol);
          if (!found.ok) return { text: found.why };

          const row = (await holdings()).find((h) => h.companyId === found.company.id);
          if (!row) {
            return {
              text:
                `The fund holds no position in ${found.company.symbol}. That is a fact about the ` +
                'book, not a gap in the data.',
            };
          }

          // An unmarked holding says so. A market value of nothing is not a market value of zero,
          // and this is exactly the case the LEFT JOIN in holdings() exists to keep visible.
          const mark = row.close === null
            ? 'no close held for this name, so it is unmarked'
            : `${row.close} on ${row.pricedOn} · market value ${row.marketValue}`;

          return {
            text: [
              `${found.company.name} (${found.company.symbol})`,
              `  quantity      ${row.quantity}`,
              `  average cost  ${row.avgCost}`,
              `  total cost    ${row.cost}`,
              `  mark          ${mark}`,
            ].join('\n'),
          };
        }),
    }),
};
