import Link from 'next/link';

import { ChatPoll } from '@/components/ChatPoll.tsx';
import { AppHeader, Blank, Button, Empty, LinkButton, Seg } from '@/components/ui.tsx';
import { listThreads, threadWithMessages, turnInFlight, type MessageRow } from '@/lib/chat/threads.ts';

import { archive, askInThread, startChat } from '../../_lib/actions/chat.ts';
import { requireUser } from '../../_lib/session.ts';
import { dayMonthTime } from '@/components/ui';

/**
 * Chat — where a question gets asked, and the agent goes and reads before answering.
 *
 * The first `.split` screen in this tree. The layout and every `ch-` class were carried forward
 * whole from v2 with the rest of the design system and have sat unused since; they are wired here
 * rather than reinvented, which is lesson L14 — a complete design once sat unwired in
 * `styles/portfolio.css` and was rebuilt by hand beside it.
 *
 * **A thread is where work starts, not where it is filed.** An agent message here is a message in
 * a conversation. Turning one into a document is `draft_document`, which is R4's, and it will land
 * in `/review` like every other draft rather than becoming the record by being written.
 *
 * State lives in the URL — `?thread=` selects, `?archived=1` widens the list — so a thread is a
 * link somebody can send and a refresh lands where you were.
 */

export const dynamic = 'force-dynamic';

/**
 * What an answer read, in one line.
 *
 * Rendered from `chat_tool_calls`, which §4.2 calls the transparency surface and not optional. A
 * failed call says so: a read that broke and a read that found nothing must never look the same.
 */
function reading(message: MessageRow, showCost: boolean) {
  if (message.role !== 'agent') return null;

  const parts = message.toolCalls.map((call) => {
    if (call.error) return `${call.tool} failed`;
    const chunks = call.chunkIds.length > 0 ? ` (${call.chunkIds.length} passages)` : '';
    return `${call.tool}${chunks}`;
  });

  return (
    <p className="ch-reading">
      {parts.length === 0 ? (
        <Blank why="This answer read nothing — it was written from the thread alone" />
      ) : (
        `Read: ${parts.join(' · ')}`
      )}
      {/* Admin-only, per 0030: a per-turn dollar figure in front of everybody invites the wrong
          argument about which questions are worth asking, and the desk is meant to ask. Where the
          figure is not known it is <Blank>, never $0.00 — that lie is D5's founding example. */}
      {showCost &&
        (message.costUsd === null ? (
          <>
            {' · '}
            <Blank why="This turn reached no answer, so what it spent was never totalled" />
          </>
        ) : (
          ` · $${message.costUsd.toFixed(4)}`
        ))}
    </p>
  );
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string; archived?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const showArchived = params.archived === '1';

  const threads = await listThreads(showArchived);
  const open = params.thread ? await threadWithMessages(params.thread) : null;
  const inFlight = open ? await turnInFlight(open.thread.id) : false;

  return (
    <>
      <AppHeader
        title="Chat"
        subtitle={
          open
            ? `${open.messages.length} message${open.messages.length === 1 ? '' : 's'} · ${
                open.thread.archivedAt ? 'archived' : 'open'
              }`
            : `${threads.length} thread${threads.length === 1 ? '' : 's'}`
        }
      />

      <div className="split split-2">
        <section className="pane">
          <div className="ch-start">
            <LinkButton href="/chat" tone="primary" className="ch-new">
              New thread
            </LinkButton>
          </div>
          <div className="pane-sub">
            <Seg
              small
              current={showArchived ? '/chat?archived=1' : '/chat'}
              options={[
                { label: 'Open', href: '/chat' },
                { label: 'All', href: '/chat?archived=1' },
              ]}
            />
          </div>
          <div className="pane-list">
            {threads.length === 0 ? (
              <Empty>No threads yet. Ask something on the right.</Empty>
            ) : (
              threads.map((t) => (
                <Link
                  key={t.id}
                  href={`/chat?thread=${t.id}${showArchived ? '&archived=1' : ''}`}
                  className="ch-row"
                  aria-current={open?.thread.id === t.id ? 'true' : undefined}
                >
                  <div className="ch-row-title">{t.title}</div>
                  <div className="ch-row-meta">
                    {t.lastAt ? dayMonthTime(t.lastAt) : dayMonthTime(t.createdAt)} · {t.messages} message
                    {t.messages === 1 ? '' : 's'}
                    {t.archivedAt ? ' · archived' : ''}
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="pane">
          <div className="pane-head">
            <div className="ch-meta">
              <strong>{open ? open.thread.title : 'A new thread'}</strong>
              {open && !open.thread.archivedAt && (
                <form action={archive}>
                  <input type="hidden" name="thread" value={open.thread.id} />
                  <Button tone="quiet" small>
                    Archive
                  </Button>
                </form>
              )}
            </div>
          </div>

          <div className="ch-log">
            {!open ? (
              <div className="ch-blank">
                <b>Ask the desk analyst</b>
                It reads the corpus, the filed figures and the book before it answers, and says what
                it could not find. Nothing it writes here enters the record on its own.
              </div>
            ) : (
              open.messages.map((m) => (
                <div key={m.id} className={`ch-msg ${m.role === 'person' ? 'is-me' : 'is-agent'}`}>
                  <span className="ch-who">
                    {m.role === 'person' ? 'You' : 'Anveshak'} · {dayMonthTime(m.writtenAt)}
                  </span>
                  <p className="ch-body">{m.body}</p>
                  {reading(m, user.isAdmin)}
                </div>
              ))
            )}

            {inFlight && (
              <div className="ch-msg is-agent">
                <span className="ch-who">Anveshak</span>
                <p className="ch-reading">Reading. This takes a few minutes at xhigh.</p>
              </div>
            )}
          </div>

          <form className="ch-composer" action={open ? askInThread : startChat}>
            {open && <input type="hidden" name="thread" value={open.thread.id} />}
            <textarea
              name="body"
              className="field"
              rows={2}
              required
              placeholder={open ? 'Ask a follow-up' : 'What do you want to know?'}
            />
            <Button tone="primary" disabled={inFlight}>
              Ask
            </Button>
          </form>
        </section>
      </div>

      <ChatPoll active={inFlight} />
    </>
  );
}
