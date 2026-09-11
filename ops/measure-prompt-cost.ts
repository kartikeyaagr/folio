/**
 * What the learned blocks add to a prompt, per agent.
 *
 * `tasks/todo.md` makes this a condition of retrieval staying:
 *
 *   > **Ground rule 5 applies.** v2 shipped a clustering stage its own measurement showed did
 *   > nothing. Before retrieval stays: measure prompt tokens per agent run with and without it, on
 *   > the same questions, and record the number in the file.
 *
 * **Read the number for what it is.** Neither block can *shrink* a prompt; the "shrink prompts"
 * half of that rule was written about content retrieval, which R3 delivered and which does shrink
 * them. This measures the price, and §7's mean-edit-distance trend on `/agents` is what says
 * whether the price bought anything.
 *
 * The two blocks are priced separately because they are bought differently. Examples are retrieved
 * on every run and grow with the corpus; rules are approved one at a time by a person, and their
 * cost is a decision somebody made rather than a number that drifts.
 *
 * Characters always; Claude tokens when a credential exists, because counting them needs Claude.
 * `count_tokens` is not inference — it generates nothing and costs nothing to speak of — but it is
 * still a call, so it is opt-in:
 *
 *   DATABASE_URL=postgres:///trisula_v3_dev pnpm exec tsx ops/measure-prompt-cost.ts
 *   DATABASE_URL=… pnpm exec tsx ops/measure-prompt-cost.ts --tokens
 *
 * Read-only. Runs no `writeTxn`/`serviceTxn`, and embeds with the local model.
 */
import { closePool, readTxn } from '../lib/db.ts';
import { exemplarCost, ruleCost, systemFor } from '../lib/agents/prompt.ts';
import type { AgentRow } from '../lib/agents/runner.ts';

interface Row extends AgentRow {
  held: number;
  rules: number;
  /** A real situation this agent was accepted on, so the match is a match and not a stranger. */
  sample: string | null;
}

async function agents(): Promise<Row[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT a.key, a.label, a.purpose, a.model, a.effort, a.data_scope, a.tools,
              a.learning, a.notify_on_draft,
              count(e.id)::int AS held,
              (SELECT count(*)::int FROM prompt_rules r
                WHERE r.agent_id = a.key AND r.status = 'approved') AS rules,
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

    // An agent with neither an embedded exemplar nor an approved rule has nothing to add to its
    // purpose. Said rather than skipped: a missing line here would read as a measurement taken.
    if (!a.sample && a.rules === 0) {
      console.log(`${a.key} (${flag}): no approved rule and no embedded exemplar — nothing to measure`);
      continue;
    }

    // Rules are retrieved by agent and examples by situation, so a sample is needed only for the
    // second. An agent with rules and no corpus still has a real number to report.
    const situation = a.sample ?? '';
    const rules = await ruleCost(a, situation);
    const examples = a.sample ? await exemplarCost(a, situation) : 0;

    console.log(
      [
        `${a.key} (${flag}): purpose ${a.purpose.length} chars`,
        `+${rules} from ${a.rules} rule${a.rules === 1 ? '' : 's'}`,
        a.sample ? `+${examples} from examples` : 'no embedded exemplar yet',
        `= ${a.purpose.length + rules + examples}`,
        `${a.held} held`,
      ].join(' · '),
    );

    if (withTokens) {
      const bare = await tokensOf(a.purpose);
      const full = await tokensOf(await systemFor(a, situation));
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
