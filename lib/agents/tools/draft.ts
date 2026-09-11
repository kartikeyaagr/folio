/**
 * `draft_document` — propose something for the record, from inside a thread.
 *
 * Writes one `ai_drafts` row with `status = 'pending'` and stops. It does not publish, and there is
 * no path from here that does: the row waits in `/review` until a person accepts it, at which point
 * `acceptDraft` writes the document as **their** write, attributed to them.
 *
 *   `v4.md §11.5` — *"Nothing an agent writes enters the record without a person accepting it, and
 *   every draft shows where it came from before and after that decision."*
 *
 * The "where it came from" half is why `sources` is built from the chunks this turn actually read
 * rather than left empty. `/review` renders an empty source list as
 * *"This draft recorded no sources, which is itself worth asking about"* — correct, and not
 * something a chat draft should be triggering by construction.
 *
 * **`kind` is `note` or `memo` only.** The other five `documents.kind` values each belong to a
 * pipeline that produces them — `transcript` to ingest, `brief` to agent 6, `checklist` to agent 7,
 * `sheet` to the editor, `meeting` to a person who was in one. A chat draft claiming to be one of
 * those would misstate where it came from, which is the single thing this table exists to keep
 * straight.
 */

import { serviceTxn } from '../../db.ts';
import { id } from '../queue.ts';
import { betaTool, resolveSubject, served, type ToolContext, type ToolSpec } from './spec.ts';

const KINDS = ['note', 'memo'] as const;

export const spec: ToolSpec = {
  name: 'draft_document',
  reads: ['companies'],
  writes: ['ai_drafts'],
  build: (ctx: ToolContext) =>
    betaTool({
      name: 'draft_document',
      description:
        'Propose a document for the record. It does not publish: it goes to the review queue as a ' +
        'pending draft, and a person accepts or rejects it. Use this when the desk asks you to ' +
        'write something up, not for ordinary answers — an answer belongs in your reply. Say in ' +
        'your reply that you proposed it and that it is waiting for review.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'body'],
        properties: {
          kind: {
            type: 'string',
            enum: [...KINDS],
            description: 'note for a short write-up, memo for a considered argument.',
          },
          title: { type: 'string', description: 'What it is, in a line somebody can pick out of a list.' },
          body: {
            type: 'string',
            description:
              'The document itself. Cite the passages you used the same way you do in an answer, ' +
              'with [chunk N] at the end of the sentence each supports.',
          },
          symbol: {
            type: 'string',
            description: 'The company it is about, if it is about one. Omit for anything wider.',
          },
        },
      },
      run: (args) =>
        served(ctx, 'draft_document', args as unknown as Record<string, unknown>, async () => {
          // A context with no `turn` has no run to hang a draft on — `ai_drafts.run_id` is NOT NULL.
          // Refused as an ordinary result rather than thrown: it is a fact about where this tool was
          // called from, not a failure of the call.
          // Bound to a local: TypeScript loses the narrowing across the awaits below, and a
          // non-null assertion at each use would be three chances to get it wrong instead of one.
          const turn = ctx.turn;
          if (!turn) {
            return { text: 'A draft can only be proposed from inside a chat turn.' };
          }

          const title = args.title.trim();
          const body = args.body.trim();
          if (!title || !body) {
            return { text: 'A draft needs both a title and a body. Nothing was written.' };
          }

          let companyId: string | null = null;
          if (args.symbol || ctx.companyId !== null) {
            const found = await resolveSubject(ctx, args.symbol);
            if (!found.ok) return { text: found.why };
            companyId = found.company.id;
          }

          // `headline` because `documentTitle` in review.ts reads exactly that key when the draft
          // is accepted, and `kind` because `landDocument` prefers it over its per-agent map. The
          // key order is the render order: jsonb re-sorts keys, so `field_order` captures it here.
          const content = { headline: title, kind: args.kind, body };

          // Passages only. The thread is provenance too, but it reaches `/review` through
          // `ai_drafts.thread_id` as a link somebody can follow — putting it here as well printed
          // the same id twice, once as "Read the conversation →" and once as raw JSON under it.
          //
          // So a draft written without reading anything has no sources, and `/review` says
          // *"This draft recorded no sources, which is itself worth asking about"*. That is the
          // correct thing to say about a write-up nothing was looked up for.
          const cited = turn.cited();
          const sources = cited.map((chunkId) => ({ kind: 'chunk', ref: chunkId }));

          const draftId = id();
          await serviceTxn('system:agents', async (c) => {
            await c.query(
              `INSERT INTO ai_drafts
                 (id, run_id, agent_key, company_id, content, sources, model, status,
                  thread_id, field_order)
               VALUES ($1,$2,'desk-analyst',$3,$4,$5,$6,'pending',$7,$8)`,
              [
                draftId, turn.runId, companyId,
                JSON.stringify(content), JSON.stringify(sources),
                turn.model, turn.threadId, Object.keys(content),
              ],
            );
          });

          return {
            text:
              `Proposed a ${args.kind} titled "${title}" as draft ${draftId}. It is pending in the ` +
              `review queue, built from ${cited.length} passage${cited.length === 1 ? '' : 's'}. ` +
              'It is not part of the record until somebody accepts it — say so in your reply.',
          };
        }),
    }),
};
