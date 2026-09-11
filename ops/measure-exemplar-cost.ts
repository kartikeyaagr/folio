/**
 * What retrieval adds to a prompt, per agent.
 *
 * `tasks/todo.md` makes this a condition of retrieval staying:
 *
 *   > **Ground rule 5 applies.** v2 shipped a clustering stage its own measurement showed did
 *   > nothing. Before retrieval stays: measure prompt tokens per agent run with and without it, on
 *   > the same questions, and record the number in the file.
 *
 * **Read the number for what it is.** Exemplar retrieval can only *add* to a prompt; the "shrink
 * prompts" half of that rule was written about content retrieval, which R3 delivered and which does
 * shrink them. This measures the price, and §7's mean-edit-distance trend on `/agents` is what says
 * whether the price bought anything.
 *
 * Characters always; Claude tokens when a credential exists, because counting them needs Claude.
 * `count_tokens` is not inference — it generates nothing and costs nothing to speak of — but it is
 * still a call, so it is opt-in:
 *
 *   DATABASE_URL=postgres:///trisula_v3_dev pnpm exec tsx ops/measure-exemplar-cost.ts
 *   DATABASE_URL=… pnpm exec tsx ops/measure-exemplar-cost.ts --tokens
 *
 * Read-only. Runs no `writeTxn`/`serviceTxn`, and embeds with the local model.
 */
import { closePool, readTxn } from '../lib/db.ts';
import { exemplarCost, systemFor } from '../lib/agents/prompt.ts';
import type { AgentRow } from '../lib/agents/runner.ts';

interface Row extends AgentRow {
  held: number;
  /** A real situation this agent was accepted on, so the match is a match and not a stranger. */
  sample: string | null;
}

async function agents(): Promise<Row[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT a.key, a.label, a.purpose, a.model, a.effort, a.data_scope, a.tools,
              a.learning, a.notify_on_draft,
              count(e.id)::int AS held,
              (SELECT e2.situation FROM exemplars e2
                WHERE e2.agent_id = a.key AND e2.embedding IS NOT NULL
                ORDER BY e2.created_at DESC LIMIT 1) AS sample
         FROM agents a
         LEFT JOIN exemplars e ON e.agent_id = a.key
        WHERE a.model <> 'none'
        GROUP BY a.key
        ORDER BY a.key`,
    );
    return rows;
  });
}

async function tokensOf(system: string): Promise<number | null> {
  try {
    const { modelClient } = await import('../lib/agents/client.ts');
    const r = await modelClient().messages.countTokens({
      model: 'claude-opus-5',
      system,
      messages: [{ role: 'user', content: 'x' }],
    });
    return r.input_tokens;
  } catch (err) {
    console.error(`  (no token count: ${String(err instanceof Error ? err.message : err)})`);
    return null;
  }
}

async function main(): Promise<void> {
  const withTokens = process.argv.includes('--tokens');
  const rows = await agents();

  for (const a of rows) {
    const flag = a.learning ? 'learning' : 'not learning';
    if (!a.sample) {
      // An agent with no embedded exemplar has nothing to retrieve, so its prompt is its purpose.
      // Said rather than skipped: a missing line here would read as a measurement that was taken.
      console.log(`${a.key} (${flag}): no embedded exemplar yet — nothing to measure`);
      continue;
    }

    const added = await exemplarCost(a, a.sample);
    const line = [
      `${a.key} (${flag}): purpose ${a.purpose.length} chars`,
      `+${added} from examples`,
      `= ${a.purpose.length + added}`,
      `${a.held} held`,
    ].join(' · ');
    console.log(line);

    if (withTokens) {
      const bare = await tokensOf(a.purpose);
      const full = await tokensOf(await systemFor(a, a.sample));
      if (bare !== null && full !== null) {
        console.log(`  tokens: ${bare} without, ${full} with, +${full - bare}`);
      }
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
