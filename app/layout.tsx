import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { currentTheme } from './_lib/theme.ts';

import './globals.css';

/**
 * Two faces, both self-hosted.
 *
 * `next/font/google` downloads at build time and serves from our own origin — no runtime request to
 * Google, which matters because this app runs on a private network and must not depend on an
 * outbound CDN to render. Both faces are on Google Fonts, which is what makes this direction
 * available at all: a CDN-only face could not be used here however good it looked.
 *
 * Geist carries everything written; Geist Mono carries every figure. The split is no longer
 * serif-versus-sans — it is prose versus number. A holdings table is read down its columns, and a
 * proportional face makes 1,42,000 and 96,400 different widths for the same number of digits, so
 * the eye has to re-find the decimal on every row.
 */
const sans = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Trisula Capital',
  description: 'Investment research and portfolio management',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // A chosen theme is rendered from the first byte. With none chosen the stylesheet follows the
  // operating system, so the attribute is simply absent rather than guessed.
  const theme = await currentTheme();
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      data-theme={theme ?? undefined}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
