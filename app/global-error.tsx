'use client';

/**
 * The boundary for a throw in `app/layout.tsx` itself.
 *
 * `error.tsx` renders *inside* the root layout, so it cannot catch the root layout failing — and
 * the root layout does real work: it reads the theme cookie, which reads a request header. When
 * that throws there is no boundary at all and the browser gets a blank document.
 *
 * It must render its own `<html>` and `<body>`, because the layout that normally supplies them is
 * the thing that just failed. That also means the root layout's stylesheet import does not apply,
 * which is why `globals.css` is imported again here — by class, not by an inline `style` object,
 * so the rule that a control without a hover state looks unfinished still holds on this screen.
 *
 * Deliberately says less than `error.tsx`. If the layout is broken then so is the theme, the rail
 * and possibly the database; offering "try again" against that is offering a coin flip.
 */
import { Failure } from '@/components/Failure.tsx';

import './globals.css';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <Failure eyebrow="Something broke" title="Trisula could not start this page.">
          <p>
            The failure is below the screen you asked for, so reloading is unlikely to help. If this
            persists, <code>systemctl status trisula-web</code> on the box is where the reason is.
          </p>
          {error.digest && (
            <p className="failure-digest">
              Quote this if you report it: <code>{error.digest}</code>
            </p>
          )}
        </Failure>
      </body>
    </html>
  );
}
