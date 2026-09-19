import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serviceTxn } from '../db.ts';
import { pathFor } from './attachments.ts';
import { NseSession } from './nse.ts';
import {
  fetchAnnualReports,
  parseAnnualReports,
  pickReport,
  storeAnnualReport,
  type AnnualReport,
} from './annual-reports.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

test('the symbol comes from the request, never from the row', () => {
  // SME rows carry a `symbol` field and mainboard rows do not. Reading it from the row gives
  // undefined for every mainboard company.
  const mainboard = [{ companyName: 'Praj Industries Limited', fromYr: '2025', toYr: '2026',
                       fileName: 'https://nsearchives.nseindia.com/annual_reports/AR_1_PRAJIND.pdf' }];
  assert.equal(parseAnnualReports('PRAJIND', mainboard)[0]?.symbol, 'PRAJIND');
});

test('a zip filename is recognised as one', () => {
  const rows = [{ fromYr: '2015', toYr: '2016',
                  fileName: 'https://nsearchives.nseindia.com/annual_reports/AR_9125_PRAJIND.zip' }];
  assert.equal(parseAnnualReports('PRAJIND', rows)[0]?.isZip, true);
});

test('a dash is null, not a date', () => {
  const rows = [{ fromYr: '2009', toYr: '2010', broadcast_dttm: '-', attFileSize: null,
                  fileName: 'https://nsearchives.nseindia.com/annual_reports/AR_PRAJIND.zip' }];
  assert.equal(parseAnnualReports('PRAJIND', rows)[0]?.disseminatedAt, null);
});

test('a row with no fileName is dropped, and the caller can tell', () => {
  // parseAnnualReports returns a plain array rather than {served, skipped} like
  // fetchAnnouncementsForSymbol does — here there is no queue row to write for a row that named
  // no file, so silently shrinking the array is the correct behaviour, not a loss to report.
  assert.equal(parseAnnualReports('PRAJIND', [{ fromYr: '2020', toYr: '2021' }]).length, 0);
});

test('zero rows for a followed symbol raises rather than returning empty', async () => {
  // Wrong board, unknown symbol and a report-less company are indistinguishable at HTTP 200, which
  // is exactly what a real 'sme' query for the mainboard-only PRAJIND would hit. Stubbed here
  // rather than hit live: nothing else in this tree's tests reaches the network, and a live call
  // would make `pnpm check` depend on NSE being reachable from wherever it runs.
  const session = new NseSession();
  mock.method(session, 'rows', async () => []);
  try {
    await assert.rejects(() => fetchAnnualReports('PRAJIND', 'sme', session), /no annual reports/i);
  } finally {
    mock.restoreAll();
  }
});

// ---------------------------------------------------------------------------------------------
// pickReport — pure, no DB.

test('a zip yields the report, not the FormA cover', () => {
  // 3 of 12 readable PRAJIND zips hold two PDFs. FormA_2015_2016.pdf is a 2-page scan that
  // extracts 0 chars, so "extract every PDF" reports a scan failure on a document that is not
  // the report.
  assert.equal(
    pickReport([
      { name: 'FormA_2015_2016.pdf', bytes: 10 },
      { name: 'AR_2015_2016.pdf', bytes: 2_000_000 },
    ]),
    'AR_2015_2016.pdf',
  );
});

test('a single-entry zip has nothing to weigh against', () => {
  // 9 of 12 readable PRAJIND zips hold exactly one entry — the ordinary case, no FormA cover.
  assert.equal(pickReport([{ name: 'AR_2020_2021.pdf', bytes: 500_000 }]), 'AR_2020_2021.pdf');
});

test('an empty zip has no report to pick', () => {
  assert.equal(pickReport([]), null);
});

// ---------------------------------------------------------------------------------------------
// storeAnnualReport — needs a real database (annual_report_attempts, attachments) and a stubbed
// NseSession so no test here reaches the network. A fresh `new NseSession()` is used rather than
// `NseSession.open()` throughout: `.bytes()` needs no primed cookie (nse.ts's own module comment —
// the archive host wants only a browser-shaped User-Agent), and skipping `open()` means no test
// has to also fake the homepage priming call.

const DB = `trisula_annual_reports_${process.pid}`;
const CO = 'c1';

let attachDir: string;

const report: AnnualReport = {
  symbol: 'PRAJIND',
  fromYr: '2025',
  toYr: '2026',
  url: 'https://nsearchives.nseindia.com/annual_reports/AR_1_PRAJIND.pdf',
  isZip: false,
  disseminatedAt: null,
  declaredBytes: null,
};

before(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'trisula-annual-reports-test-'));
  process.env['ATTACHMENT_DIR'] = attachDir;

  await createTestDatabase(DB);

  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'PRAJIND','Praj Industries Limited')", [CO]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
  rmSync(attachDir, { recursive: true, force: true });
});

/**
 * A fetch stub keyed by URL, standing in for the network `NseSession.bytes()` reaches through the
 * global `fetch`. Returns real `Response` objects so `NseSession.bytes()`'s own content-length
 * assertion runs unmodified — this is what actually exercises the truncation trap, not a mock of
 * `bytes()` itself, which would skip over the code under test.
 */
function stubFetch(responses: Record<string, { body: Buffer; declaredLength?: number; status?: number }>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const r = responses[url];
    if (!r) throw new Error(`unstubbed fetch in test: ${url}`);
    const headers = new Headers();
    if (r.declaredLength !== undefined) headers.set('content-length', String(r.declaredLength));
    // `new Uint8Array(buffer)` rather than the Buffer itself: TS's DOM lib types BodyInit against
    // Uint8Array<ArrayBuffer>, and Buffer's own ArrayBufferLike generic does not satisfy it.
    return new Response(new Uint8Array(r.body), { status: r.status ?? 200, headers });
  };
}

test('an archive with no central directory is terminal, not retried', async () => {
  // The FY2019-20 archive, verified live: full content-length, one local file header, zero
  // central-directory entries. zipfile raises BadZipFile on it; lib/import/zip.ts raises
  // UnreadableZip the same way, reading the central directory rather than half-reading the file.
  const badZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(96)]);
  const url = 'https://nsearchives.nseindia.com/annual_reports/AR_16894_PRAJIND_2019_2020.zip';
  mock.method(globalThis, 'fetch', stubFetch({
    [url]: { body: badZip, declaredLength: badZip.length },
  }));
  try {
    await serviceTxn('system:ingest', async (c) => {
      const state = await storeAnnualReport(
        c,
        CO,
        { ...report, fromYr: '2019', toYr: '2020', isZip: true, url },
        new NseSession(),
      );
      assert.equal(state, 'unavailable');

      const { rows } = await c.query(
        'SELECT state, reason FROM annual_report_attempts WHERE company_id = $1 AND from_yr = $2',
        [CO, '2019'],
      );
      assert.equal(rows[0].state, 'unavailable');
      assert.match(rows[0].reason, /zip|archive/i);
    });
  } finally {
    mock.restoreAll();
  }
});

test('a short body throws rather than storing a prefix', async () => {
  // Both NSE and SEBI were observed truncating silently under HTTP 200. A truncated annual report
  // extracts to plausible text and enters the record as a complete one, so this must throw rather
  // than resolve to a state at all.
  const url = 'https://nsearchives.nseindia.com/annual_reports/AR_SHORT_PRAJIND.pdf';
  mock.method(globalThis, 'fetch', stubFetch({
    [url]: { body: Buffer.from('truncated'), declaredLength: 1_000_000 },
  }));
  try {
    await serviceTxn('system:ingest', async (c) => {
      await assert.rejects(
        () => storeAnnualReport(c, CO, { ...report, fromYr: '2018', url }, new NseSession()),
        /content-length|truncat/i,
      );
    });
    // The throw must not have left a terminal row behind — this is a transport fault worth
    // retrying, not a fact about the document.
    await serviceTxn('system:ingest', async (c) => {
      const { rows } = await c.query(
        'SELECT 1 FROM annual_report_attempts WHERE company_id = $1 AND from_yr = $2',
        [CO, '2018'],
      );
      assert.equal(rows.length, 0);
    });
  } finally {
    mock.restoreAll();
  }
});

test('a year already stored is not fetched again', async () => {
  const pdf = Buffer.from('%PDF-1.4 '.repeat(1000));
  mock.method(globalThis, 'fetch', stubFetch({
    [report.url]: { body: pdf, declaredLength: pdf.length },
  }));
  try {
    await serviceTxn('system:ingest', async (c) => {
      const first = await storeAnnualReport(c, CO, report, new NseSession());
      assert.equal(first, 'stored');

      const { rows } = await c.query<{ sha256: string; kind: string; company_id: string }>(
        'SELECT sha256, kind, company_id FROM attachments WHERE filename = $1',
        ['AR_1_PRAJIND.pdf'],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, 'annual_report');
      assert.equal(rows[0]!.company_id, CO);
      assert.deepEqual(await readFile(pathFor(rows[0]!.sha256)), pdf);

      // The mock has only one response registered; a second network call here would throw
      // "unstubbed fetch" and fail the test outright, not silently pass.
      const second = await storeAnnualReport(c, CO, report, new NseSession());
      assert.equal(second, 'held');
    });
  } finally {
    mock.restoreAll();
  }
});

test('an unavailable year is not retried', async () => {
  // The whole reason the attempt table exists: NSE has no FY2021-22 for PRAJIND and never will.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO annual_report_attempts (company_id, from_yr, state, reason)
       VALUES ($1, '2021', 'unavailable', 'not in NSE payload')`,
      [CO],
    );
    // No fetch stubbed at all: if storeAnnualReport reached the network here, the real global
    // fetch would run and the test would hang or fail on a live call, not pass quietly.
    const state = await storeAnnualReport(c, CO, { ...report, fromYr: '2021' }, new NseSession());
    assert.equal(state, 'held');
  });
});
