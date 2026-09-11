/**
 * `run_agent` — put another agent's run on the queue from inside a thread.
 *
 * **Its output goes to `/review`, never back into the thread.** `v4.md §6.3`: *"Chat becomes how
 * you ask; it does not become where the answer is filed."* A thread that filled up with other
 * agents' drafts would be a second review queue with no accept button, and the gate only works
 * because there is exactly one place work waits for a person.
 *
 * The `/agents` "Ask an agent" form stays. This is an additional way to invoke, not a replacement —
 * a form that queues a known agent against a known company should not require a conversation.
 */

import { enqueue } from '../queue.ts';
import { betaTool, resolveSubject, served, type ToolContext, type ToolSpec } from './spec.ts';

/**
 * The agents a thread may queue, and why only these two.
 *
 * Agents 1 and 2 are **event**-triggered: `results-figures` needs a specific `fundamentals` row and
 * `concall-insights` a specific transcript, both carried as `subject_ref`. A thread has a company
 * at best, so queueing either produces a run that claims, fails with `no fundamentals row null`,
 * retries twice and lands on `/agents` as a failure nobody caused on purpose. Refusing up front and
 * naming the reason beats a dead end the model cannot predict from the tool's description.
 *
 * `desk-analyst` is excluded for a different reason: an agent that can queue itself is a loop with
 * a bill attached.
 *
 * Agents 4 and 5 (`email-workflow`, `reminders`) call no model and run on their own schedule.
 * Nothing in a conversation should be draining the outbox.
 */
const INVOCABLE: Record<string, { needsCompany: boolean; what: string }> = {
  'forensics-review': {
    needsCompany: true,
    what: "work the fund's 14-item forensic checklist against a company's annual filings",
  },
  'news-brief': {
    needsCompany: false,
    what: 'brief the desk on the last few days across the names it follows',
  },
};

/** Exported so a test can assert each of these is seeded, enabled and calls a model. */
export const INVOCABLE_KEYS = Object.keys(INVOCABLE);

export const spec: ToolSpec = {
  name: 'run_agent',
  reads: ['companies'],
  writes: ['agent_runs'],
  build: (ctx: ToolContext) =>
    betaTool({
      name: 'run_agent',
      description:
        'Queue one of this system\'s other agents. Its answer does NOT come back to you or into ' +
        'this thread — it goes to the review queue, where a person accepts or rejects it. Use this ' +
        'when the desk asks for work that is somebody else\'s job, and say in your answer that you ' +
        'queued it. Available: ' +
        Object.entries(INVOCABLE).map(([k, v]) => `${k} (${v.what})`).join('; ') + '.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['agent'],
        properties: {
          agent: { type: 'string', enum: Object.keys(INVOCABLE), description: 'Which agent to queue.' },
          symbol: {
            type: 'string',
            description: 'Exchange symbol. Required for forensics-review; optional for news-brief, ' +
              'which covers every followed name when omitted.',
          },
        },
      },
      run: (args) =>
        served(ctx, 'run_agent', args as unknown as Record<string, unknown>, async () => {
          const wanted = INVOCABLE[args.agent];
          // Unreachable through the schema's enum, and checked anyway: the enum is a request the
          // model can ignore, and this is the boundary that would otherwise let it.
          if (!wanted) {
            return { text: `${args.agent} cannot be queued from a thread.` };
          }

          let companyId: string | null = null;
          if (args.symbol || wanted.needsCompany || ctx.companyId !== null) {
            const found = await resolveSubject(ctx, args.symbol);
            if (!found.ok) return { text: found.why };
            companyId = found.company.id;
          }

          const runId = await enqueue({
            agentKey: args.agent,
            companyId,
            // Not attributed to a person: nobody clicked anything. The thread is the provenance,
            // and `agent_runs.requested_by` references `users`, which a service principal is not.
            requestedBy: null,
          });

          return {
            text:
              `Queued ${args.agent}${companyId ? ` for ${args.symbol}` : ''} as run ${runId}. ` +
              'It runs on the next sweep and its draft goes to the review queue, not to this ' +
              'thread. Tell the desk you queued it; do not wait for it or describe what it found.',
          };
        }),
    }),
};
