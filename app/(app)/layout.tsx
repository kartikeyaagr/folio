import type { ReactNode } from 'react';

import { AvatarMenu } from '@/components/AvatarMenu.tsx';
import { Rail } from '@/components/Rail.tsx';
import { ThemeToggle } from '@/components/ThemeToggle.tsx';
import { Toast } from '@/components/Toast.tsx';
import { MailboxPrompt } from '@/components/MailboxPrompt.tsx';
import { mailboxFor, shouldPromptForMailbox } from '@/lib/mailbox.ts';

import { setTheme } from '../_lib/actions/theme.ts';
import { readFlash } from '../_lib/flash.ts';
import { requireUser } from '../_lib/session.ts';
import { railData } from '../_lib/shell.ts';
import { currentTheme } from '../_lib/theme.ts';

/**
 * The authentication boundary for the whole application.
 *
 * Every page in this route group inherits it, so a new page is protected by *existing* rather than
 * by its author remembering a check. Making a page public means deliberately putting it in
 * (public), which is the only way in.
 *
 * The shell is a navy rail and a content column. Pages own their own header, so the title and the
 * one line under it come from the page's own data.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [shell, theme, message, mailbox, askAboutMailbox] = await Promise.all([
    railData(user.userId),
    currentTheme(),
    readFlash(),
    // In the layout because the avatar menu is in the layout, and because the one thing this is
    // for — noticing that your own mailbox stopped working — is only useful if it is on the screen
    // you are already looking at rather than one you have to go to.
    mailboxFor(user.userId),
    shouldPromptForMailbox(user.userId),
  ]);

  return (
    <div className="app-shell">
      <Rail
        badges={shell.badges}
        isAdmin={user.isAdmin}
        themeToggle={<ThemeToggle theme={theme} action={setTheme} />}
        menu={<AvatarMenu email={user.email} name={shell.name} isAdmin={user.isAdmin} mailbox={mailbox} />}
      />
      <div className="app-main">{children}</div>
      <Toast message={message} />
      {askAboutMailbox && <MailboxPrompt email={user.email} />}
    </div>
  );
}
