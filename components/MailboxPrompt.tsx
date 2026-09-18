'use client';

import { useEffect, useRef } from 'react';

import { dismissMailboxPromptAction, linkMailboxAction } from '@/app/_lib/actions/account.ts';

/**
 * The one thing worth interrupting a first sign-in for.
 *
 * `0055` let a person send their own daily update from their own company address, and put the
 * control in the avatar menu — which is where a thing like that belongs and also where nobody
 * finds it. This asks once.
 *
 * **A prompt and not a gate**, decided at the fund's instruction after the alternative was put:
 * somebody who declines still gets their digest through the shared desk relay. Linking changes
 * which address it comes from, and nothing else. So there is a real "Not now" and it is a button
 * of equal weight, not a link in small grey text.
 *
 * **`showModal()` rather than `<dialog open>`**, which is the difference between a dialog and a box.
 * A dialog with the bare `open` attribute renders *in flow*: no top layer, no `::backdrop`, and the
 * page shows through it — measured here first, with the rail's own labels bleeding through the
 * Server field. Only a modal dialog gets the backdrop `.dlg::backdrop` styles, and only script can
 * make one, so this is a client component for the same reason `DialogButton` is.
 *
 * It has no close affordance beyond the two buttons, and no light-dismiss: both buttons answer the
 * question and both record that it was asked, so the prompt cannot become a dialog somebody learns
 * to wave away. `cancel` is prevented for the same reason — Escape would leave it unanswered and it
 * would open again on the next page. It is shown once in a person's life, whichever button is
 * pressed.
 */
export function MailboxPrompt({ email }: { email: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="dlg first-run"
      aria-labelledby="mbx-prompt-title"
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dlg-body">
      <h2 id="mbx-prompt-title">Where should your daily update come from?</h2>
      <p className="sub">
        Every morning you get one email: what was raised, what is due, and what is waiting in
        Review. It goes to <b>{email}</b> either way.
      </p>
      <p className="sub">
        Link that mailbox and the update is sent from it as well. Saving sends a test message and
        links nothing unless it arrives. The password is encrypted, is used only to send you this
        email, and is never shown again. Nothing reads your mail.
      </p>

      <form action={linkMailboxAction} className="form-grid">
        <label className="lbl">
          Server
          <input className="field" name="host" placeholder="smtp.hostinger.com" required />
        </label>
        <label className="lbl">
          Port
          <select className="field" name="port" defaultValue="587">
            <option value="587">587 — STARTTLS</option>
            <option value="465">465 — TLS</option>
            <option value="2525">2525 — STARTTLS</option>
          </select>
        </label>
        <label className="lbl">
          Mailbox
          <input className="field" name="username" type="email" defaultValue={email}
                 autoComplete="username" required />
        </label>
        <label className="lbl">
          Password
          <input className="field" name="password" type="password" autoComplete="off" required />
        </label>
        <input type="hidden" name="from" value={email} />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">Link</button>
        </div>
      </form>

      {/* Its own form, because it posts nothing and must not carry the fields above with it. */}
      <form action={dismissMailboxPromptAction}>
        <button type="submit" className="btn btn-quiet">
          Skip
        </button>
      </form>
      </div>
    </dialog>
  );
}
