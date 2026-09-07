import type { NextConfig } from 'next';

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
};

export default config;
