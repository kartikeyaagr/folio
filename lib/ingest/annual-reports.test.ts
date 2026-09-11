import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { NseSession } from './nse.ts';
import { fetchAnnualReports, parseAnnualReports } from './annual-reports.ts';

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
