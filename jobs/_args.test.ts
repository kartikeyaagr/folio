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

test('a timer that names a wall-clock time names the zone it means', async () => {
  // `trisula-distil-rules.timer` said `OnCalendar=*-*-* 19:30` and was the only one of fifteen
  // without `Asia/Kolkata`. systemd reads a bare time in the *manager's* zone, which on this VM
  // is UTC, so "once a day, after the desk has closed" fired at 01:00 IST the next morning.
  //
  // Same family as the insider-disclosure bug fixed on this branch: a time with no zone is read
  // in whatever zone the box happens to have, and this box is not in the one the fund works in.
  // A periodic interval — `*:0/10`, every ten minutes — is zone-independent and is skipped.
  const { readdir, readFile } = await import('node:fs/promises');
  const units = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'systemd');

  let checked = 0;
  for (const file of (await readdir(units)).filter((f) => f.endsWith('.timer'))) {
    for (const line of (await readFile(path.join(units, file), 'utf8')).split('\n')) {
      const m = /^OnCalendar=(.+)$/.exec(line.trim());
      if (!m) continue;
      const spec = m[1]!;
      if (!/\d{4}|\*-\*-\*|Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(spec)) continue; // a bare interval
      checked++;
      assert.match(spec, /\s[A-Za-z]+\/[A-Za-z_]+$/, `${file} schedules a wall-clock time without a timezone: ${spec}`);
    }
  }
  assert.ok(checked >= 10, `expected to check most of the timers, checked ${checked}`);
});

test('StartLimit lives in [Unit], where systemd still reads it', async () => {
  // Moved out of [Service] in systemd v229, and silently ignored if left there. Both watchers had
  // it in [Service] until 21-Sep-2026, each under a comment explaining that without it a crash
  // loop never reaches `failed` — so neither property held, and `trisula-backfill-watch`'s
  // `OnFailure=trisula-alert@%n.service` could never fire. Exactly §2.6's "a crash-looping
  // service reaches nobody", with the fix written into the wrong section.
  const { readdir, readFile } = await import('node:fs/promises');
  const units = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'systemd');

  let checked = 0;
  for (const file of (await readdir(units)).filter((f) => f.endsWith('.service'))) {
    let section = '';
    for (const line of (await readFile(path.join(units, file), 'utf8')).split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) section = trimmed;
      if (!/^StartLimit(IntervalSec|Burst)=/.test(trimmed)) continue;
      checked++;
      assert.equal(section, '[Unit]', `${file} sets ${trimmed.split('=')[0]} in ${section}, where systemd ignores it`);
    }
  }
  assert.ok(checked >= 2, `expected both watchers to set it, found ${checked}`);
});
