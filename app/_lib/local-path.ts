/**
 * Where to send somebody after they sign in: a path on this origin, or `/`.
 *
 * `next` arrives in a query string anybody can write, so an absolute URL here is an open redirect
 * — the login page becomes a credible way to deliver somebody to a lookalike. The check used to be
 * `startsWith('/') && !startsWith('//')`, which `/\evil.com` passes: browsers read `\` as `/` in
 * an http(s) URL, so the Location header it produced was `//evil.com`, a different host. The URL
 * parser also deletes tab and newline before it parses, which turns `/\t/evil.com` into the same
 * thing — hence no backslash, no whitespace and no control character anywhere, not merely after
 * the first slash.
 *
 * The pattern alone is not enough. Dot segments pass it and normalise away: `/..//evil.com`,
 * `/%2e%2e//evil.com` and `/a/..//evil.com` all resolve to the path `//evil.com`, which Next's
 * client router then reads as a network-path reference to another host. Found by review
 * 25-Sep-2026 against the production build: the router pushed `//<host>/…` and only the browser's
 * same-origin check on `pushState` stopped the navigation, crashing the page instead. So the value
 * is resolved, and what is returned is the normalised path, never the raw input.
 *
 * No imports, so `node:test` can load it without Next.
 */
export function localPath(next: string): string {
  if (!/^\/(?![/\\])[^\\\s\x00-\x1f\x7f]*$/.test(next)) return '/';
  const url = new URL(next, 'http://local');
  return url.pathname.startsWith('//') ? '/' : url.pathname + url.search + url.hash;
}
