/**
 * Talking to NSE.
 *
 * The JSON endpoints refuse a request that has not first been given a cookie by the homepage, and
 * they refuse one whose User-Agent looks automated. Neither is documented; both were found by
 * getting 401s. This module exists so that knowledge lives in one place rather than in every
 * fetcher.
 *
 * The archive host (`nsearchives.nseindia.com`) serves CSV and XML without the cookie dance, but
 * still wants a browser-shaped User-Agent.
 */

import { parse } from 'csv-parse/sync';

const BASE = 'https://www.nseindia.com';

/**
 * Every request here is bounded.
 *
 * A socket NSE accepts and never answers holds a `oneshot` unit in "activating" indefinitely: it
 * never fails, so `OnFailure=` never fires, and the job simply never runs again. The 30-minute
 * `TimeoutStartSec` on `folio-job@.service` is the backstop for that and costs half an hour of
 * silence; this is the actual fix, and `lib/news/poll.ts` has had it since it was written.
 *
 * Generous on purpose. The bhavcopy is a multi-megabyte zip and the announcements endpoint answers
 * slowly under load; this is a bound on a hang, not a latency budget.
 */
const TIMEOUT_MS = 30_000;

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/csv, */*',
  Referer: `${BASE}/`,
};

export class NseError extends Error {
  /** Declared and assigned: strip-only mode rejects a parameter property at runtime. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A session holding NSE's homepage cookie.
 *
 * Node's fetch does not keep a cookie jar, so the Set-Cookie values are captured from the homepage
 * response and replayed by hand. That is the whole mechanism: without it every API call 401s.
 */
export class NseSession {
  private cookie = '';

  static async open(): Promise<NseSession> {
    const s = new NseSession();
    await s.prime();
    return s;
  }

  private async prime(): Promise<void> {
    const response = await fetch(BASE, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const set = response.headers.getSetCookie?.() ?? [];
    this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (!this.cookie) {
      throw new NseError('NSE returned no cookie; the JSON endpoints will refuse every call');
    }
  }

  private headers(): Record<string, string> {
    return this.cookie ? { ...HEADERS, Cookie: this.cookie } : HEADERS;
  }

  /**
   * A JSON API call. Returns the first array in the payload, which is where NSE hides the rows.
   *
   * `referer` exists because a few endpoints check that the request looks like it came from the
   * page that normally makes it. The insider-trading endpoint answers 503 without it.
   */
  async rows<T = Record<string, unknown>>(
    path: string,
    params?: Record<string, string>,
    referer?: string,
  ): Promise<T[]> {
    const url = new URL(`${BASE}/api/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

    const headers = referer ? { ...this.headers(), Referer: referer } : this.headers();
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new NseError(`${response.status} from ${url.pathname}`, response.status);

    return pickRows<T>(await response.json());
  }

  /**
   * Raw bytes from anywhere on NSE, archives included.
   *
   * Both NSE and SEBI have been observed serving a body short of its own declared `content-length`
   * under a full HTTP 200 — the connection closes early and nothing about the response says so. A
   * truncated PDF still often extracts plausible text, so a shortfall throws here, once, rather
   * than being handed to every caller as a complete document. A plain `Error`, not `NseError`: this
   * is a transport fault worth retrying, not a fact about what NSE has at the URL.
   */
  async bytes(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: this.headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new NseError(`${response.status} fetching ${url}`, response.status);
    const buf = Buffer.from(await response.arrayBuffer());
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && buf.length < declared) {
      throw new Error(
        `truncated: ${url} declared content-length ${declared}, delivered ${buf.length} bytes`,
      );
    }
    return buf;
  }

  async text(url: string): Promise<string> {
    return (await this.bytes(url)).toString('utf8');
  }
}

/**
 * Find the rows in a JSON payload.
 *
 * `data` by name before any array by position. The insider endpoint answers
 * `{acqNameList: [...], data: [...]}`, and taking the first array found returned a list of people's
 * names — which parsed to nothing and stored nothing, with a 200 and no error anywhere. Endpoints
 * that answer with a bare array or with some other single key still work by position.
 */
export function pickRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const named = (payload as Record<string, unknown>)['data'];
    if (Array.isArray(named)) return named as T[];
    const positionalRows = Object.values(payload).find((v) => Array.isArray(v));
    if (positionalRows) return positionalRows as T[];
  }
  return [];
}

/**
 * Parse a CSV into positional rows, the header among them.
 *
 * Hand-written until 18-Sep-2026, on the argument that "NSE's masters are plain comma-separated
 * with quoted fields and no embedded newlines". That was true of the masters, and had quietly
 * stopped being true of the callers: `lib/import/index.ts` passes whatever somebody uploaded from
 * the fund's shared drive. The old reader split on newlines *before* it looked at quotes, so a
 * quoted cell containing one — ordinary Excel output — became two rows with every later column
 * shifted, and no error anywhere. On a securities master that invents a symbol out of the tail of
 * an address.
 *
 * `relax_column_count` because the masters are ragged in places and a short row should still read
 * rather than throw. `bom` because Excel prefixes one on export; the old reader stripped it only
 * by accident, `String.prototype.trim()` counting U+FEFF as whitespace.
 */
export function parseCsvRows(text: string): string[][] {
  return parse(text, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
}

/**
 * Parse a CSV with a header row, keyed by column name.
 *
 * Collapses two columns that share a name, which is correct here — a master's columns are found
 * by name, and `field()` below is how. It is wrong for a grid, whose columns are found by
 * position, so `csvToSheet` reads `parseCsvRows` instead.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsvRows(text);
  if (!header) return [];
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

/**
 * NSE spells the same column differently between its mainboard and SME masters
 * ("NAME OF COMPANY" against "NAME_OF_COMPANY"), so every read names every spelling it accepts.
 */
export function field(row: Record<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = row[n] ?? row[n.toUpperCase()] ?? row[n.replace(/ /g, '_')];
    if (v !== undefined && v !== '') return v.trim();
  }
  return '';
}
