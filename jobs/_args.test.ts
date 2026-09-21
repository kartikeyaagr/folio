import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BadUsage, readFlags } from './_args.ts';

/**
 * Two of these describe what the hand-rolled reader did wrong. They are operator-facing rather
 * than data-facing, which is why they had never been caught: nothing fails, the job just does
 * something other than what was asked.
 */

test('a flag reads in both spellings', () => {
  assert.equal(readFlags(['symbol'], [], ['--symbol', 'AERON']).str('symbol'), 'AERON');
  // The equals form was silently unsupported: `--symbol=AERON` read as no symbol at all, and
  // jobs/backfill-filings.ts then backfilled every followed name.
  assert.equal(readFlags(['symbol'], [], ['--symbol=AERON']).str('symbol'), 'AERON');
});

test('an unknown flag is refused rather than ignored', () => {
  // `--symbl AERON` used to mean "every followed name", which is the broadest thing the job does.
  assert.throws(() => readFlags(['symbol'], [], ['--symbl', 'AERON']), BadUsage);
});

test('the refusal names what the job does accept', () => {
  try {
    readFlags(['symbol'], ['dry-run'], ['--nope']);
    assert.fail('should have refused');
  } catch (err) {
    assert.ok(err instanceof BadUsage);
    assert.match(err.message, /--symbol <value>/);
    assert.match(err.message, /--dry-run/);
  }
});

test('a value-taking flag given another flag as its value is refused', () => {
  // `set-admin --email --revoke` read "--revoke" as the address, then reported no such account.
  assert.throws(() => readFlags(['email'], ['revoke'], ['--email', '--revoke']), BadUsage);
});

test('a boolean flag is present or absent, never a string', () => {
  const on = readFlags([], ['list'], ['--list']);
  assert.equal(on.bool('list'), true);
  assert.equal(readFlags([], ['list'], []).bool('list'), false);
});

test('an absent flag is undefined, so a job can fall back to its default', () => {
  assert.equal(readFlags(['days'], [], []).str('days'), undefined);
});

test('a positional argument is refused, because no job here takes one', () => {
  assert.throws(() => readFlags(['symbol'], [], ['AERON']), BadUsage);
});

test('every flag a systemd unit passes is one the job it runs will accept', async () => {
  // `trisula-backfill-watch.service` ran `backfill-company.ts --watch` from the day it was
  // written, and `backfill-company.ts` parsed with `strict: true` without declaring `watch`. So
  // the watcher died on startup with "Unknown option '--watch'" every time, and the on-add
  // backfill silently fell back to the ten-minute timer — the design's second half, dead, with
  // nothing failing loudly enough to say so.
  //
  // A unit file and the job it invokes are two files nobody diffs against each other. This reads
  // both: for every `--flag` in an ExecStart that runs a job, the job must either declare it in
  // `readFlags` or read it off `process.argv` itself.
  const { readdir, readFile } = await import('node:fs/promises');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const units = path.join(here, '..', 'ops', 'systemd');

  let checked = 0;
  for (const unit of (await readdir(units)).filter((f) => f.endsWith('.service'))) {
    const text = await readFile(path.join(units, unit), 'utf8');
    for (const line of text.split('\n')) {
      const exec = /^ExecStart=.*?tsx\s+jobs\/([A-Za-z0-9_-]+)\.ts\s*(.*)$/.exec(line.trim());
      if (!exec) continue;
      const [, job, rest] = exec;
      const flags = [...(rest ?? '').matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!);
      if (flags.length === 0) continue;
      const src = await readFile(path.join(here, `${job}.ts`), 'utf8');
      // The rule is asymmetric, and the asymmetry is the whole point. `readFlags` parses with
      // `strict: true` and throws on the first undeclared option, so a job that calls it *must*
      // declare the flag — reading `process.argv` further down is too late, because the throw
      // already happened. Only a job that never calls `readFlags` may read argv directly, which
      // is what `index-content.ts` does.
      //
      // Written the other way round first, accepting either, and it passed with the bug put back:
      // `process.argv.includes('--watch')` satisfied the fallback. A guard that cannot fail is
      // worse than none, because it reads as cover.
      const usesReadFlags = /\breadFlags\s*\(/.test(src);
      for (const flag of flags) {
        const declared = usesReadFlags
          ? new RegExp(`readFlags\\([^)]*['"]${flag}['"]`, 's').test(src)
          : src.includes(`'--${flag}'`);
        assert.ok(
          declared,
          usesReadFlags
            ? `${unit} runs ${job}.ts --${flag}, and ${job}.ts parses strictly without declaring it`
            : `${unit} runs ${job}.ts --${flag}, which ${job}.ts never reads`,
        );
        checked++;
      }
    }
  }
  // A test that silently checks nothing is the failure mode this whole file is about.
  assert.ok(checked >= 2, `expected to check at least the two watchers, checked ${checked}`);
});
