'use client';

/**
 * What a person sees when a page throws.
 *
 * **This file and `global-error.tsx` are the only two `'use client'` files in `app/`**, and that is
 * not a drift in the rule — Next requires an error boundary to be a client component, because it
 * needs `componentDidCatch` and a `reset` the browser can call. ARCHITECTURE.md §9 records the
 * property as "two, and they are the two Next's API mandates". Both are kept to a shell that
 * renders `components/Failure.tsx` and nothing else, so no application logic crosses the boundary
 * with them.
 *
 * What it replaces was Next's own production boundary: an unstyled grey *"Application error: a
 * server-side exception has occurred"* with a digest hash, outside the shell, with no way back.
 * On a system whose Postgres is on the same box as its web process, that screen is what a
 * ten-second database blip looks like to the desk.
 *
 * The digest is shown deliberately. It is the only handle that ties what the person saw to the
 * line in `journalctl -u trisula-web` that explains it, and without it the report is "it broke".
 * It reveals nothing: Next generates it precisely so the message itself does not have to be sent.
 */
import { Failure } from '@/components/Failure.tsx';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Failure
      eyebrow="Something broke"
      title="This screen did not load."
      action={
        <button className="failure-act failure-act-primary" type="button" onClick={reset}>
          Try again
        </button>
      }
    >
      <p>
        The failure is on the server, not in what you did — nothing you were looking at has been
        changed. Trying again is worth one attempt; if it fails twice the cause will outlast a
        third.
      </p>
      {error.digest && (
        <p className="failure-digest">
          Quote this if you report it: <code>{error.digest}</code>
        </p>
      )}
    </Failure>
  );
}
