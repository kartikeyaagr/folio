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
import { drainOutbox, smtpFromEnv, smtpSender } from '../notify.ts';
import { deliverDue } from '../reminders.ts';

export const EMAIL_KEY = 'email-workflow';
export const REMINDERS_KEY = 'reminders';

registerHandler(EMAIL_KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, ['notification_outbox']);
  const cfg = smtpFromEnv();
  const r = await drainOutbox(cfg ? smtpSender(cfg) : null);
  // A run with no relay configured is honest rather than green: it says what is waiting.
  if (!cfg && r.skipped > 0) {
    console.log(`${r.skipped} notifications waiting; no SMTP relay configured`);
  }
  return { done: true };
});

registerHandler(REMINDERS_KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, ['reminders']);
  await deliverDue();
  return { done: true };
});
