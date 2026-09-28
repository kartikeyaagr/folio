/**
 * Is this box actually ready?
 *
 * `ops/SETUP.md` is long prose and an operator following it had no way to check they had.
 * Every finding below is something that has either bitten this system or would have: pgvector
 * missing kills `pnpm migrate` at 40 of 62; a first account without admin cannot approve the
 * access request that would create the second account; a missing embedding model turns four
 * learning agents into permanent failures that requeue every six hours forever.
 *
 *   pnpm preflight
 *
 * Reads and changes nothing. Four outcomes, not two, and that is the point:
 *
 *   ok       checked, and right
 *   note     a valid state worth saying out loud, with its consequence named
 *   bad      checked, and wrong
 *   unknown  could NOT be checked here
 *
 * Exit 0 only when everything was checked and nothing was wrong; 1 if anything is `bad`; 2 if
 * nothing is bad but something could not be checked. `unknown` is separated from `ok` for the same
 * reason a job returning zero items is a failure in this system: a check that did not run must
 * never read as a check that passed. Running this on a laptop reports the systemd checks as
 * `unknown`, which is honest, rather than as `ok`, which would be a lie about the VM.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, readTxn } from '../lib/db.ts';
import { chosenBackend, modelClient } from '../lib/agents/client.ts';
import { attachmentDir } from '../lib/ingest/attachments.ts';
import { mailboxKeyPresent } from '../lib/mailbox.ts';
import { modelDirs } from '../lib/retrieval/embed.ts';

type Level = 'ok' | 'note' | 'bad' | 'unknown';
interface Result {
  level: Level;
  name: string;
  detail: string;
}

const results: Result[] = [];
const say = (level: Level, name: string, detail: string): void => {
  results.push({ level, name, detail });
};

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The two constants `ops/fetch-model.sh` validates a download against. Changing one changes both. */
const MODEL_BYTES = 133_093_490;
const TOKENIZER_SHA256 = 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66';

/**
 * An age X25519 recipient: `age1` and 58 bech32 characters, whose alphabet excludes 1, b, i and o.
 *
 * Shape only — it cannot tell the right key from a wrong one, which is what §12's laptop-side
 * drill is for. It catches the case that drill cannot: `ops/verify-backup.sh` generates its own
 * throwaway keypair, so a blank or malformed recipient passes the Sunday drill every week while
 * every nightly archive is ciphertext nobody can open.
 */
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};

const writable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// The database, and the schema it is supposed to be carrying

async function checkDatabase(): Promise<boolean> {
  if (!env('DATABASE_URL')) {
    say('bad', 'DATABASE_URL', 'not set — nothing below that needs the database can be checked');
    return false;
  }
  try {
    await readTxn(async (c) => c.query('SELECT 1'));
    say('ok', 'postgres', 'answered');
    return true;
  } catch (e) {
    say('bad', 'postgres', `did not answer: ${(e as Error).message}`);
    return false;
  }
}

async function checkVector(): Promise<void> {
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    return rows;
  });
  if (rows.length > 0) say('ok', 'pgvector', 'extension present');
  else
    say(
      'bad',
      'pgvector',
      'extension `vector` is absent. Migration 0040 creates it and chunks.embedding is ' +
        'vector(384); install postgresql-18-pgvector and create it in template1 as postgres (SETUP §4)',
    );
}

/**
 * Postgres's own zone, which `TZ=Asia/Kolkata` on every unit does not reach (lesson L19).
 *
 * The date arithmetic is in SQL — `current_date` in `lib/alerts.ts` and `lib/company-view.ts` — so
 * a UTC cluster, which is what `initdb` gives on an EC2 image, answers with yesterday's date for
 * every Indian clock time before 05:30. It was fixed on the first box by hand on 09-Sep-2026 and
 * never written into §4, so a rebuilt box would have lost it silently. Checked by offset rather
 * than by name because `Asia/Calcutta` is the same zone under its old name.
 */
const IST_OFFSET_S = 5.5 * 3600;

async function checkTimezone(): Promise<void> {
  const { zone, utc_offset } = await readTxn(async (c) => {
    const { rows } = await c.query<{ zone: string; utc_offset: number }>(
      "SELECT current_setting('TimeZone') AS zone, EXTRACT(TIMEZONE FROM now())::int AS utc_offset",
    );
    return rows[0]!;
  });
  if (utc_offset === IST_OFFSET_S) say('ok', 'db timezone', zone);
  else
    say(
      'bad',
      'db timezone',
      `${zone}, so current_date is yesterday before 05:30 IST. ` +
        "ALTER DATABASE folio SET timezone = 'Asia/Kolkata' (SETUP §4)",
    );
}

/**
 * Both directions, because they fail differently.
 *
 * A file on disk with no row is un-applied schema — the app will query columns that do not exist.
 * A row with no file is a migration that was renamed or deleted after it ran, which is how
 * `folio_dev` ended up carrying both 0052 and the renumbered 0062 of the same migration.
 */
async function checkMigrations(): Promise<void> {
  const onDisk = readdirSync(path.join(REPO, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = await readTxn(async (c) => {
    const { rows } = await c.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    return new Set(rows.map((r) => r.filename));
  });
  const pending = onDisk.filter((f) => !applied.has(f));
  const orphan = [...applied].filter((f) => !onDisk.includes(f)).sort();

  if (pending.length > 0)
    say('bad', 'migrations', `${pending.length} not applied, from ${pending[0]} — run pnpm migrate`);
  else say('ok', 'migrations', `all ${onDisk.length} applied`);

  if (orphan.length > 0)
    say('note', 'migrations', `${orphan.length} applied with no file on disk: ${orphan.join(', ')}`);
}

async function checkAccounts(): Promise<void> {
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ live: string; admins: string }>(
      `SELECT count(*) FILTER (WHERE disabled_at IS NULL)::text AS live,
              count(*) FILTER (WHERE disabled_at IS NULL AND is_admin)::text AS admins
         FROM users`,
    );
    return rows[0]!;
  });
  const live = Number(row.live);
  const admins = Number(row.admins);

  if (live === 0) {
    say('bad', 'accounts', 'no account exists — SETUP §11 seeds the first one');
    return;
  }
  if (admins === 0)
    say(
      'bad',
      'accounts',
      `${live} account(s), none admin. /admin and /agents both redirect to /, so nobody can ` +
        'approve an access request and no second user can be created through the UI. ' +
        'Run jobs/set-admin.ts --email <address>',
    );
  else say('ok', 'accounts', `${live} live, ${admins} admin`);
}

async function checkSecurities(): Promise<void> {
  const n = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM securities');
    return Number(rows[0]!.n);
  });
  if (n > 0) say('ok', 'securities', `${n.toLocaleString('en-IN')} in the master`);
  else
    say(
      'bad',
      'securities',
      'the security master is empty — nothing can add a company. ' +
        'Run jobs/refresh-securities.ts (SETUP §11)',
    );
}

// ---------------------------------------------------------------------------------------------
// Everything the box holds outside Postgres

function checkModel(): void {
  const tried = modelDirs();
  const dir = tried.find(
    (d) => existsSync(`${d}/model.onnx`) && existsSync(`${d}/tokenizer.json`),
  );
  if (dir === undefined) {
    say(
      'bad',
      'embed model',
      `not found in ${tried.join(', ')}. Four learning agents retrieve exemplars through it, so ` +
        'without it every one of their runs fails and requeues every six hours forever. ' +
        'Run pnpm fetch-model',
    );
    return;
  }

  // Size and hash, not presence. fetch-model.sh's own header records why: without curl -f a
  // proxy's 403 lands in the output file and exits 0, so a 400-byte HTML page becomes model.onnx
  // and the next thing anybody notices is ONNX failing deep inside a matmul.
  const bytes = statSync(`${dir}/model.onnx`).size;
  if (bytes !== MODEL_BYTES) {
    say('bad', 'embed model', `${dir}/model.onnx is ${bytes} bytes, expected ${MODEL_BYTES}`);
    return;
  }
  const sha = createHash('sha256').update(readFileSync(`${dir}/tokenizer.json`)).digest('hex');
  if (sha !== TOKENIZER_SHA256) {
    say('bad', 'embed model', `${dir}/tokenizer.json hashed ${sha.slice(0, 16)}…, expected ${TOKENIZER_SHA256.slice(0, 16)}…`);
    return;
  }
  say('ok', 'embed model', `${dir}, size and hash both match`);
}

/**
 * Not "is a credential configured" but "does the far end accept it".
 *
 * Presence was the whole check until 23-Sep-2026, and it passed on a box whose key was a
 * well-formed 108-character `sk-ant-api0…` that the API answered 401 to. Every agent run then
 * failed with `failure_kind='error'`, was requeued six hours later, and failed again — visible
 * only as a growing failed-runs list on /agents.
 *
 * `models.list` is the cheapest authenticated call there is: no tokens, no model, no cost. It
 * goes through `modelClient()` so federation and a plain key are both exercised the way the agents
 * exercise them, rather than through a hand-rolled header that could be right here and wrong there.
 *
 * A network failure is `unknown`, not `bad`. A box with no egress yet is not a box with a bad key,
 * and the difference is the entire reason this script has four outcomes instead of two.
 */
async function checkCredentialLive(): Promise<void> {
  let client: ReturnType<typeof modelClient>;
  try {
    client = modelClient();
  } catch (e) {
    // With no backend at all checkCredential has already said so. With one, it does not re-derive
    // every rule clientFor() enforces (AWS_REGION for the AWS backend, for one), and a silent
    // return here printed `ok model credential` and no reachability line for a box that cannot
    // build a client.
    if (chosenBackend() !== null) say('bad', 'model reachable', (e as Error).message);
    return;
  }
  try {
    // Ten seconds and no retries: the SDK's defaults (600s, two retries) turned a box with blocked
    // egress into a preflight that hung for half an hour instead of saying `unknown`.
    await client.models.list({ limit: 1 }, { timeout: 10_000, maxRetries: 0 });
    say('ok', 'model reachable', 'the API accepted this credential');
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403)
      say(
        'bad',
        'model reachable',
        `the API rejected this credential (${status}). Every agent run will fail as ` +
          "failure_kind='error' and requeue every six hours forever",
      );
    // 429 and 5xx (529 is Anthropic's "overloaded") are the far end having a moment, not this box
    // being wrong: `unknown`, so an API incident does not read as NOT READY.
    else if (status === 429 || (status !== undefined && status >= 500))
      say('unknown', 'model reachable', `the API is not answering properly right now (${status})`);
    else if (status !== undefined)
      say('bad', 'model reachable', `the API answered ${status}`);
    else
      say('unknown', 'model reachable', `could not reach the API: ${(e as Error).message}`);
  }
}

function checkCredential(): void {
  const backend = chosenBackend();
  if (backend === null) {
    say(
      'bad',
      'model credential',
      'none resolves. Agent runs will queue, fail and retry indefinitely. Set ANTHROPIC_API_KEY, ' +
        'or ANTHROPIC_FEDERATION_RULE_ID with its pair (SETUP §6, §10)',
    );
    return;
  }
  if (backend === 'oidc-federation') {
    const missing = (['ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE'] as const)
      .filter((k) => !env(k));
    if (missing.length > 0) {
      say('bad', 'model credential', `federation selected but ${missing.join(' and ')} unset`);
      return;
    }
    const file = env('ANTHROPIC_IDENTITY_TOKEN_FILE')!;
    if (!existsSync(file)) {
      say(
        'bad',
        'model credential',
        `federation selected but ${file} does not exist — is folio-identity-token.timer enabled?`,
      );
      return;
    }
  }
  if (backend === 'anthropic-api')
    say('ok', 'model credential', 'anthropic-api (a key on disk; SETUP §10 is the upgrade)');
  else say('ok', 'model credential', backend);
}

function checkBackups(): void {
  const recipient = env('BACKUP_AGE_RECIPIENT');
  if (!recipient)
    say('bad', 'backup key', 'BACKUP_AGE_RECIPIENT unset — ops/backup.sh fails outright (SETUP §7)');
  else if (!AGE_RECIPIENT.test(recipient))
    say(
      'bad',
      'backup key',
      'BACKUP_AGE_RECIPIENT is not a well-formed age1 recipient. The weekly drill uses a ' +
        'throwaway key and would not notice, while every nightly archive is undecryptable',
    );
  else say('ok', 'backup key', 'recipient well-formed (shape only — §12 proves it is the right one)');

  const dir = env('BACKUP_DIR') ?? '/var/lib/folio/backups';
  if (writable(dir)) say('ok', 'backup dir', dir);
  else say('bad', 'backup dir', `${dir} is not writable by this user`);

  if (!env('BACKUP_S3_BUCKET'))
    say('note', 'backup offsite', 'BACKUP_S3_BUCKET unset — backups stay on this box only');
}

function checkPaths(): void {
  const dir = attachmentDir();
  if (writable(dir) || writable(path.dirname(dir))) say('ok', 'attachments', dir);
  else
    say(
      'bad',
      'attachments',
      `${dir} is not writable. Importing a file from the UI writes here; under the web unit's ` +
        'ProtectSystem=strict it needs to be in ReadWritePaths=',
    );
}

function checkWeb(): void {
  const appUrl = env('APP_URL');
  if (!appUrl)
    say(
      'bad',
      'APP_URL',
      'unset — app/logout/route.ts falls back to http://localhost:3100, so signing out on this ' +
        'box lands on a dead tab',
    );
  else {
    try {
      new URL(appUrl);
      say('ok', 'APP_URL', appUrl);
    } catch {
      say('bad', 'APP_URL', `${appUrl} is not a URL`);
    }
  }

  // Under the documented topology — Tailscale straight to 127.0.0.1:3100, no proxy — this must
  // stay unset. Next sets x-forwarded-for with ??=, so with no proxy rewriting it the value is
  // whatever the client typed, and a rate-limit key the caller chooses lets them both evade the
  // limit and lock somebody else out of /login.
  if (env('TRUST_PROXY_HEADER') === '1')
    say(
      'note',
      'proxy header',
      'TRUST_PROXY_HEADER=1 — correct ONLY if a reverse proxy on this box rewrites ' +
        'x-forwarded-for. With Tailscale and no proxy it hands the rate-limit key to the caller',
    );
  else say('ok', 'proxy header', 'TRUST_PROXY_HEADER unset (correct with no reverse proxy)');
}

function checkMail(): void {
  const host = env('SMTP_HOST');
  const from = env('SMTP_FROM');
  if (host && from) say('ok', 'mail', `relay ${host} as ${from}`);
  else if (!host && !from)
    say(
      'note',
      'mail',
      'no relay configured. A valid state — the outbox queues and nothing fails — but no alert, ' +
        'digest or job failure leaves this box',
    );
  else
    say(
      'bad',
      'mail',
      `only ${host ? 'SMTP_HOST' : 'SMTP_FROM'} is set. smtpFromEnv() needs both and returns ` +
        'null with one, so this reads as configured and sends nothing',
    );

  if (!env('MAILBOX_KEY'))
    say('note', 'mailbox key', 'MAILBOX_KEY unset — linking a personal mailbox refuses (SETUP §9b)');
  else if (!mailboxKeyPresent())
    say('bad', 'mailbox key', 'MAILBOX_KEY is not 32 bytes of base64 — AES-256-GCM needs exactly that');
  else say('ok', 'mailbox key', 'present, 32 bytes');

  if (!env('HEARTBEAT_URL'))
    say(
      'note',
      'heartbeat',
      'HEARTBEAT_URL unset. jobs/heartbeat.ts runs and pings nothing, so nothing would notice ' +
        'this box dying — the one failure that survives the box being off',
    );
  else say('ok', 'heartbeat', 'URL set');
}

// ---------------------------------------------------------------------------------------------
// systemd. Derived from ops/systemd/, never a list written out here — a hard-coded roster is how
// "a new timer is not enabled by copying it" becomes a thing nobody checks.

function checkUnits(): void {
  let systemctl: string;
  try {
    systemctl = execFileSync('sh', ['-c', 'command -v systemctl'], { encoding: 'utf8' }).trim();
    if (!systemctl) throw new Error('absent');
  } catch {
    say('unknown', 'systemd', `no systemctl on ${process.platform} — cannot check units from here`);
    return;
  }

  const state = (unit: string, verb: 'is-enabled' | 'is-active'): string => {
    try {
      return execFileSync(systemctl, [verb, unit], { encoding: 'utf8' }).trim();
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return out ? out.trim() : 'unknown';
    }
  };

  const dir = path.join(REPO, 'ops', 'systemd');
  const timers = readdirSync(dir).filter((f) => f.endsWith('.timer')).sort();
  const federated = chosenBackend() === 'oidc-federation';

  const off: string[] = [];
  for (const file of timers) {
    const unit = file;
    // The token refresher is only wanted when federation is the backend it refreshes for.
    if (unit === 'folio-identity-token.timer' && !federated) continue;
    if (state(unit, 'is-enabled') !== 'enabled') off.push(unit);
  }
  if (off.length > 0) say('bad', 'timers', `${off.length} not enabled: ${off.join(', ')}`);
  else say('ok', 'timers', `${timers.length - (federated ? 0 : 1)} enabled`);

  for (const unit of ['folio-web.service', 'folio-index-watch.service', 'folio-backfill-watch.service']) {
    const s = state(unit, 'is-active');
    if (s === 'active') say('ok', unit.replace(/^folio-|\.service$/g, ''), 'active');
    else say('bad', unit.replace(/^folio-|\.service$/g, ''), `is-active says ${s}`);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Each database check under the one name it reports as, whether it ran or not. Run separately so a
 * box with no schema yet — the first thing `pnpm preflight` is likely to meet — reports every check
 * instead of dying on `relation "schema_migrations" does not exist` with nothing printed.
 */
const DB_CHECKS: [string, () => Promise<void>][] = [
  ['pgvector', checkVector],
  ['db timezone', checkTimezone],
  ['migrations', checkMigrations],
  ['accounts', checkAccounts],
  ['securities', checkSecurities],
];

async function main(): Promise<void> {
  const live = await checkDatabase();
  for (const [name, check] of DB_CHECKS) {
    if (!live) {
      say('unknown', name, 'the database did not answer');
      continue;
    }
    try {
      await check();
    } catch (e) {
      say('bad', name, `the check itself failed: ${(e as Error).message}`);
    }
  }

  checkModel();
  checkCredential();
  await checkCredentialLive();
  checkBackups();
  checkPaths();
  checkWeb();
  checkMail();
  checkUnits();

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.level.padEnd(8)} ${r.name.padEnd(width)}  ${r.detail}`);

  const bad = results.filter((r) => r.level === 'bad');
  const unknown = results.filter((r) => r.level === 'unknown');
  const notes = results.filter((r) => r.level === 'note');
  console.log(
    `\n${results.length - bad.length - unknown.length - notes.length} ok · ${notes.length} noted · ` +
      `${bad.length} wrong · ${unknown.length} not checked`,
  );

  if (bad.length > 0) {
    console.error(`\nNOT READY: ${bad.length} check(s) failed.`);
    process.exitCode = 1;
  } else if (unknown.length > 0) {
    console.error(`\nINCONCLUSIVE: ${unknown.length} check(s) could not run here. Nothing is wrong` +
      ' with what was checked, which is not the same as nothing being wrong.');
    process.exitCode = 2;
  } else {
    console.log('\nREADY: every check ran and passed.');
  }
}

try {
  await main();
} finally {
  await closePool();
}
