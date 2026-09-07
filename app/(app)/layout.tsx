import type { ReactNode } from 'react';

import { AvatarMenu } from '@/components/AvatarMenu.tsx';
import { Rail } from '@/components/Rail.tsx';
import { ThemeToggle } from '@/components/ThemeToggle.tsx';
import { Toast } from '@/components/Toast.tsx';

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
  const [shell, theme, message] = await Promise.all([
    railData(user.userId),
    currentTheme(),
    readFlash(),
  ]);

  return (
    <div className="app-shell">
      <Rail
        badges={shell.badges}
        themeToggle={<ThemeToggle theme={theme} action={setTheme} />}
        menu={<AvatarMenu email={user.email} name={shell.name} />}
      />
      <div className="app-main">{children}</div>
      <Toast message={message} />
    </div>
  );
}
