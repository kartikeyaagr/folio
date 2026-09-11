'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { enqueue } from '@/lib/agents/queue.ts';
import { runNow } from '@/lib/agents/runner.ts';
import { archiveThread, ask, startThread, turnInFlight } from '@/lib/chat/threads.ts';
import { AGENT_KEY } from '@/lib/chat/turn.ts';
// Imported for its side effect: registering agent 8's handler. `runNow` looks the handler up in a
// map, so without this the run fails with "no handler registered" — which is a real failure kind
// and would be recorded as one, on a run a person is watching.
import '@/lib/agents/desk.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Put a turn on the queue and start working it now.
 *
 * Enqueued first, worked second, and both matter. The `agent_runs` row is what gives a chat turn a
 * lease, a retry count, a named failure kind and a line on `/agents` — everything an unattended run
 * gets. Working it immediately is because a person is sitting there and the agents timer is every
 * five minutes.
 *
 * `after()` rather than a bare floating promise: it is Next's own contract for work that outlives
 * the response, so the turn is not racing the request that started it. If this process dies
 * mid-turn the lease expires and the timer picks the run up — which is the whole reason it is a
 * row rather than a function call.
 */
async function work(threadId: string, actorId: string): Promise<void> {
  const runId = await enqueue({ agentKey: AGENT_KEY, subjectRef: threadId, requestedBy: actorId });
  after(async () => {
    try {
      await runNow(runId);
    } catch (err) {
      // executeRun records handler failures itself; this catches the ones around it, which would
      // otherwise be an unhandled rejection in the web process and nothing on any screen.
      console.error(`chat run ${runId} failed outside the handler:`, err);
    }
  });
}

export async function startChat(form: FormData): Promise<void> {
  const user = await requireUser();
  const body = String(form.get('body') ?? '');
  if (!body.trim()) {
    await flash('A thread starts with a question.');
    redirect('/chat');
  }

  const threadId = await startThread(body, user.userId);
  await work(threadId, user.userId);
  redirect(`/chat?thread=${threadId}`);
}

export async function askInThread(form: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = String(form.get('thread') ?? '');
  const body = String(form.get('body') ?? '');

  if (!body.trim()) {
    await flash('A question needs words.');
    redirect(`/chat?thread=${threadId}`);
  }

  // One turn at a time. Two questions in flight would produce two answers interleaved into one
  // thread, each having read a transcript that did not include the other.
  if (await turnInFlight(threadId)) {
    await flash('It is still working on the last question.');
    revalidatePath('/chat');
    return;
  }

  await ask(threadId, body, user.userId);
  await work(threadId, user.userId);
  revalidatePath('/chat');
}

export async function archive(form: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = String(form.get('thread') ?? '');
  await archiveThread(threadId, user.userId);
  await flash('Thread archived. It is kept, not deleted.');
  redirect('/chat');
}
