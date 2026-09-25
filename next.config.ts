import type { NextConfig } from 'next';

/**
 * Sent on every response, pages and route handlers alike.
 *
 * `'self'`, never `'none'`, for framing and objects: `components/FiledDocument.tsx` embeds each
 * filed PDF from `/api/attachment` in an `<object>`, and `frame-ancestors`, `X-Frame-Options` and
 * `object-src` all govern `<object>` — the stricter values blank every filing in the app. Same
 * origin still refuses the clickjacking case, which is a page on another host.
 *
 * No `script-src`. Next's inline bootstrap scripts need a per-request nonce to survive one, and
 * that is a change to how every page renders rather than a header; SECURITY.md records it as
 * deferred.
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; base-uri 'self'; object-src 'self'" },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // A document or company URL carries what the fund is looking at; a link out to NSE or a news
  // feed should not hand it over.
  { key: 'Referrer-Policy', value: 'same-origin' },
  // Production only: `tailscale serve` terminates TLS on the VM (ops/SETUP.md §8a), while
  // `pnpm dev` is plain http on localhost, where browsers ignore the header anyway.
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
    : []),
];

/**
 * Node's strip-only TypeScript is what the jobs run under, so `lib/` carries `.ts` extensions on
 * its relative imports. Next resolves those through the bundler, so both worlds read the same
 * files without a build step in between.
 */
const config: NextConfig = {
  // The app is internal and lives behind a private network. Nothing here is indexed, and no
  // outbound CDN is used at runtime — the fonts are self-hosted at build time.
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
  headers: async () => [{ source: '/:path*', headers: SECURITY_HEADERS }],
  experimental: {
    serverActions: {
      // Next refuses a server-action body over 1MB by default, before the action runs, so
      // `importFileAction`'s own 32MB cap (MAX_UPLOAD in lib/import/index.ts) was
      // unreachable: every DRHP and most annual reports failed as an error page rather than
      // importing. One megabyte over the cap leaves room for the multipart envelope, so a file just
      // over it still reaches the action and gets its sentence. The limit is global — Next has no
      // per-action setting — which is acceptable on a box only the tailnet can reach.
      bodySizeLimit: '33mb',
    },
    // The second limit on the same request, and the one the first fix missed. Every POST that
    // `middleware.ts` matches — every page in the app, so every server action — has its body
    // cloned for the middleware, and past this size (10MB by default) Next ends BOTH copies,
    // including the one the action then reads. Measured 25-Sep-2026 on a 21.4MB annual report:
    // "Request body exceeded 10MB … Only the first 10MB will be available", then "Unexpected end of
    // form" and the error page. Kept equal to bodySizeLimit; `lib/import/limits.test.ts` checks both.
    middlewareClientMaxBodySize: '33mb',
  },
};

export default config;
