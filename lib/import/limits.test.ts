/**
 * Next refuses an oversized request body before a server action runs, so an upload cap above
 * Next's limits is unreachable: the file fails as an error page instead of getting the action's
 * sentence. There are two such limits on the same request, and this tree met both on 25-Sep-2026:
 * the server-action body limit (1MB by default), and the middleware's copy of the body (10MB by
 * default), past which Next truncates the copy the action reads too. The cap and the limits live in
 * different files; this holds them in order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../../next.config.ts';
import { MAX_UPLOAD } from './index.ts';

/** Next parses these with the `bytes` package, where a megabyte is 2^20. */
const bytes = (limit: unknown, fallback: string): number => {
  const text = String(limit ?? fallback);
  const mb = /^(\d+)mb$/i.exec(text);
  assert.ok(mb, `${text} is not in the NNmb form this test reads`);
  return Number(mb[1]) * 2 ** 20;
};

test('Next admits an action body larger than the import cap', () => {
  assert.ok(bytes(config.experimental?.serverActions?.bodySizeLimit, '1mb') > MAX_UPLOAD);
});

test('and the middleware does not truncate one either', () => {
  assert.ok(bytes(config.experimental?.middlewareClientMaxBodySize, '10mb') > MAX_UPLOAD);
});
