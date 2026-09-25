import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localPath } from './local-path.ts';

test('a path on this origin survives, query string and all', () => {
  assert.equal(localPath('/portfolio'), '/portfolio');
  assert.equal(localPath('/company/ABC?tab=filings&filter=annual'), '/company/ABC?tab=filings&filter=annual');
  assert.equal(localPath('/'), '/');
});

test('anything that leaves the origin is sent home instead', () => {
  for (const hostile of [
    'https://evil.com',
    '//evil.com',
    // The one the old startsWith check let through: browsers read `\` as `/`.
    '/\\evil.com',
    '/\\/evil.com',
    // The URL parser strips tab and newline before parsing, so these become `//evil.com`.
    '/\t/evil.com',
    '/\n/evil.com',
    'evil.com',
    'javascript:alert(1)',
    '',
    // Dot segments pass the character check and normalise to `//evil.com`.
    '/..//evil.com',
    '/.//evil.com',
    '/%2e%2e//evil.com',
    '/a/..//evil.com',
  ]) {
    assert.equal(localPath(hostile), '/', JSON.stringify(hostile));
  }
});

test('what comes back is the normalised path, not the raw input', () => {
  assert.equal(localPath('/company/../portfolio'), '/portfolio');
  assert.equal(localPath('/./review#top'), '/review#top');
});
