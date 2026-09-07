import type { Metadata, Viewport } from 'next';
import { Lora, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import { currentTheme } from './_lib/theme.ts';

import './globals.css';

/**
 * Two faces, both self-hosted.
 *
 * `next/font/google` downloads at build time and serves from our own origin — no runtime request to
 * Google, which matters because this app runs on a private network and must not depend on an
 * outbound CDN to render.
 *
 * Manrope carries the chrome; Lora carries anything that is a document. That split is the point:
 * this product's artefacts are written records, and they should not look like UI.
 */
const sans = Manrope({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const serif = Lora({
  subsets: ['latin'], variable: '--font-serif', display: 'swap', style: ['normal', 'italic'],
});

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
      className={`${sans.variable} ${serif.variable}`}
      data-theme={theme ?? undefined}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
