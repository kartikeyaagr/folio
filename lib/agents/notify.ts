/**
 * Agents 4 and 5 — the notification path.
 *
 * Neither prompts a model. They are agents rather than plain jobs because that is what makes the
 * registry true: v2 listed both and then ran them from their own timers, so neither ever appeared
 * in agent_runs and "did the mail go out" was a different question from "did the agents run".
 * Here they claim, fail and retry like everything else.
 */

import { registerHandler, type HandlerResult, type RunContext } from './runner.ts';
import { assertInScope } from './runner.ts';
import { smtpFromEnv, smtpSender } from '../notify.ts';
import { DIGEST_HOUR, sendDigests } from '../digest.ts';
import { deliverDue } from '../reminders.ts';

export const EMAIL_KEY = 'email-workflow';
export const REMINDERS_KEY = 'reminders';

/**
 * Agent 4 sends the day's digest, not the day's mail.
 *
 * It used to call `drainOutbox`, which sends one mail per queued row. At the fund's instruction
 * (17-Sep-2026) a person now gets **one envelope a morning and never more**, so the drain is
 * replaced by `sendDigests`, which gathers every unsent row for a person into one mail and marks
 * them sent together. `drainOutbox` is kept and still exported: it is the right shape for a
 * one-off, and deleting it would mean rewriting it the first time somebody wants a single mail
 * sent now. The news brief was that first time (jobs/agents.ts, 28-Sep-2026).
 *
 * The agent's timer runs more often than once a day on purpose — `DIGEST_HOUR` is the gate, so the
 * envelope goes out shortly after 07:00 IST rather than whenever the timer first fires after
 * midnight.
 */
registerHandler(EMAIL_KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, ['notification_outbox']);
  const cfg = smtpFromEnv();
  const r = await sendDigests(cfg ? smtpSender(cfg) : null);
  // A run that sends nothing is honest rather than green: it says who is waiting and why they are
  // still waiting. An empty outbox says nothing at all, which is the ordinary state of a quiet desk.
  if (r.skipped > 0) {
    console.log(
      `${r.skipped} digest(s) not sent: ` +
        (cfg ? `before ${DIGEST_HOUR}:00 IST` : 'no SMTP relay configured'),
    );
  }
  return { done: true };
});

registerHandler(REMINDERS_KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, ['reminders']);
  await deliverDue();
  return { done: true };
});
