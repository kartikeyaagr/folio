import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn, type Client } from '../db.ts';
import { contentHash, registerAll, textFor } from './register.ts';
import { chunkCells } from './chunk.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_reg_${process.pid}`;
const CO = 'c1'; // Praj Industries Limited — the fund's own name
const CO2 = 'c2'; // a second followed name, for the news fan-out case

const DOC_ID = 'd_main';
// What DOC_ID's current version reads after test 4 edits it, and what test 5 re-saves verbatim.
const EXISTING_TEXT = 'entirely different text about the auditor';

const UNGATED_ITEM_ID = 'n_ungated';
const NO_TEXT_SHA = 'sha_scanned_no_text';
const SHARED_SHA = 'sha_shared_by_two_filings';

/**
 * Not an existing export — `saveDocument` (lib/workspace.ts) needs a person's writeTxn and always
 * appends unconditionally, which is exactly the behaviour this exercises, so the test gets its own
 * minimal insert rather than a mock of the real one.
 */
async function saveNewVersion(c: Client, docId: string, text: string): Promise<void> {
  await c.query(
    `INSERT INTO document_versions (document_id, body, written_by) VALUES ($1, $2, 'system:index')`,
    [docId, JSON.stringify({ text })],
  );
}

before(async () => {
  await createTestDatabase(DB);

  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'PRAJIND','Praj Industries Limited')", [
      CO,
    ]);
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'SECOND','Second Followed Co')", [CO2]);

    // A document with one baseline version, edited later by tests 4 and 5.
    await c.query(
      `INSERT INTO documents (id, company_id, title, created_by) VALUES ($1,$2,'Meeting note','system:index')`,
      [DOC_ID, CO],
    );
    await saveNewVersion(c, DOC_ID, 'first draft, before the edit');

    // News: one confirmed, one not (the gate's own vocabulary — a candidate never reaches a
    // person), and one confirmed for two followed companies at once, which is a real shape
    // (news_matches is one row per item+company) that the registration query must not choke on.
    await c.query(
      "INSERT INTO news_sources (key,label,url,tier,market) VALUES ('src','A wire','https://x/f',1,'india')",
    );
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title, summary)
       VALUES ('n_confirmed','src','n_confirmed','https://x/1','Board approves buyback','Details follow')`,
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m1','n_confirmed',$1,'name','matched on registered name','confirmed','company said so')`,
      [CO],
    );
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title)
       VALUES ($1,'src',$1,'https://x/2','A trade-press mention with no stated mechanism')`,
      [UNGATED_ITEM_ID],
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state)
       VALUES ('m2',$1,$2,'sector_term','vocabulary only','ungated')`,
      [UNGATED_ITEM_ID, CO],
    );
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title)
       VALUES ('n_two','src','n_two','https://x/3','A story naming both followed names')`,
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m3','n_two',$1,'name','named directly','confirmed','both named as counterparties')`,
      [CO],
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m4','n_two',$1,'name','named directly','confirmed','both named as counterparties')`,
      [CO2],
    );

    // Attachments: a scan with nothing extracted, and one PDF filed twice under different
    // announcements — real shape of content-addressed storage, verified against the live corpus
    // (register.ts's ATTACHMENTS comment).
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ($1,$2,'scan.pdf','application/pdf',100,'other','system:ingest')`,
      [NO_TEXT_SHA, CO],
    );
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, extracted_text, added_by)
       VALUES ($1,$2,'presentation.pdf','application/pdf',100,'presentation','the deck says nothing new','system:ingest')`,
      [SHARED_SHA, CO],
    );
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at, attachment_sha256)
       VALUES ('fil_early',$1,'PRAJIND','Press Release','Early notice','2024-06-01T10:00:00Z',$2)`,
      [CO, SHARED_SHA],
    );
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at, attachment_sha256)
       VALUES ('fil_late',$1,'PRAJIND','Press Release','Latest notice','2025-01-15T10:00:00Z',$2)`,
      [CO, SHARED_SHA],
    );

    // Filings: one linked to a followed company, one not — the wide-net feed's normal shape.
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at)
       VALUES ('fil_linked',$1,'PRAJIND','Outcome of Board Meeting','The board approved the interim dividend.','2025-02-01T09:00:00Z')`,
      [CO],
    );
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at)
       VALUES ('fil_unlinked',NULL,'SOMEOTHER','General Updates','Nothing to do with our names.','2025-02-01T09:00:00Z')`,
    );

    // Fundamentals: a restated quarter (superseded) and the figures that replaced it.
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, revenue, profit_after_tax)
       VALUES ('f_new',$1,'consolidated','2025-01-01','2025-03-31','quarter',$2,$3)`,
      [CO, 693.2 * 1e7, 58.1 * 1e7],
    );
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, revenue, profit_after_tax, superseded_by)
       VALUES ('f_old',$1,'consolidated','2025-01-01','2025-03-31','quarter',$2,$3,'f_new')`,
      [CO, 680 * 1e7, 55 * 1e7],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

test('only the current version of a document is registered', async () => {
  // Older versions exist to be read by a person, not retrieved five times over with slightly
  // different wording — proven here by content, since ref_id is the document's own id (stable
  // across saves) rather than a version row's, precisely so a re-save can be recognised as the
  // same thing (see the other tests below).
  const docId = 'd_versions';
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, created_by) VALUES ($1,$2,'Versioned note','system:index')`,
      [docId, CO],
    );
    await saveNewVersion(c, docId, 'the old, superseded wording');
    await saveNewVersion(c, docId, 'the current wording');
    await registerAll(c);
    const { rows } = await c.query(
      `SELECT content_hash FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
      [docId],
    );
    assert.equal(rows.length, 1, 'one row per document, not one per version');
    assert.equal(rows[0].content_hash, contentHash('the current wording'));
  });
});

test('only confirmed news is registered', async () => {
  // A candidate — here, ungated — has no stated mechanism. It is not the fund's knowledge.
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM sources s WHERE s.kind = 'news_item' AND s.ref_id = $1`, [
      UNGATED_ITEM_ID,
    ]);
    assert.equal(rows[0].n, 0);
  });
});

test('a story confirmed for two followed companies does not crash registration', async () => {
  // news_matches is one row per (item, company); a story can confirm for more than one followed
  // name. Without DISTINCT ON, two rows proposing the same (kind, ref_id) in one INSERT make
  // Postgres refuse the whole statement.
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const { rows } = await c.query(`SELECT company_id FROM sources WHERE kind = 'news_item' AND ref_id = 'n_two'`);
    assert.equal(rows.length, 1, 'one row, not one per confirmed company');
    assert.equal(rows[0].company_id, CO, 'the tie-break is deterministic: lowest company_id wins');
  });
});

test('registering twice registers nothing the second time', async () => {
  await serviceTxn('system:index', async (c) => {
    // A fixture of its own, so `first` reflects something genuinely new rather than whatever
    // earlier tests already registered.
    await c.query(
      `INSERT INTO documents (id, company_id, title, created_by) VALUES ('d_once',$1,'Once','system:index')`,
      [CO],
    );
    await saveNewVersion(c, 'd_once', 'registered exactly once');
    const first = await registerAll(c);
    const second = await registerAll(c);
    assert.ok(first > 0, 'the fixture just inserted must register');
    assert.equal(second, 0, 'nothing changed between the two calls');
  });
});

test('an edited document is re-queued with a new hash', async () => {
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    await c.query('UPDATE sources SET indexed_at = now()');
    await saveNewVersion(c, DOC_ID, EXISTING_TEXT);
    await registerAll(c);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM sources WHERE indexed_at IS NULL`);
    assert.equal(rows[0].n, 1);
  });
});

test('a re-save with identical text does not re-queue', async () => {
  // The whole reason content_hash exists: six saves in an afternoon cost one embed.
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    await c.query('UPDATE sources SET indexed_at = now()');
    await saveNewVersion(c, DOC_ID, EXISTING_TEXT);
    await registerAll(c);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM sources WHERE indexed_at IS NULL`);
    assert.equal(rows[0].n, 0);
  });
});

// Retraction tests (archiving, superseding, rejecting a match, and the over-deletion negative) live
// in reap.test.ts now — split out once the reap mechanism they exercise (lib/retrieval/reap.ts)
// grew enough dedicated per-kind tests to want its own file. This file stays focused on admission:
// what registerAll proposes to INSERT, and why.

test('an attachment with no filings row is still registered', async () => {
  // The Task 12 gate. An annual report from /api/annual-reports is not an announcement and has no
  // filings row; nor does a PDF someone drags into the import dialog. An inner join would index
  // neither, and the failure is silent — the bytes are there and the search finds nothing.
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind,
                                extracted_text, added_by)
       VALUES ('abc123', $1, 'AR_2025.pdf', 'application/pdf', 100, 'annual_report',
               'the auditor was replaced during the year', 'system:ingest')`,
      [CO],
    );
    await registerAll(c);
    const { rows } = await c.query(
      `SELECT company_id, occurred_at FROM sources WHERE kind = 'attachment' AND ref_id = 'abc123'`,
    );
    assert.equal(rows.length, 1, 'a filings-less attachment must still be indexable');
    assert.equal(rows[0].company_id, CO, 'company must fall back to attachments.company_id');
    assert.ok(rows[0].occurred_at, 'occurred_at must fall back to attachments.added_at');
  });
});

test('a PDF with no extracted text is not registered', async () => {
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM sources WHERE kind = 'attachment' AND ref_id = $1`, [
      NO_TEXT_SHA,
    ]);
    assert.equal(rows[0].n, 0);
  });
});

test('an attachment filed under two announcements does not crash registration, and picks one deterministically', async () => {
  // filings.attachment_sha256 is not unique — the same content-addressed PDF can back more than
  // one announcement. Verified against the live corpus (register.ts's ATTACHMENTS comment); this
  // is the regression test for it.
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const { rows } = await c.query(`SELECT title FROM sources WHERE kind = 'attachment' AND ref_id = $1`, [SHARED_SHA]);
    assert.equal(rows.length, 1, 'one row, not one per referencing filing');
    assert.equal(rows[0].title, 'Latest notice', 'the most recently announced filing wins the tie-break');
  });
});

test('a filing is registered only when linked to a followed company', async () => {
  // fetchAnnouncements (lib/ingest/filings.ts) stores the exchange's whole feed so a newly
  // followed name arrives with its history attached; most rows are never linked to any of our
  // names, and indexing them would bury every filing search in strangers' announcements.
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const linked = await c.query(`SELECT company_id FROM sources WHERE kind = 'filing' AND ref_id = 'fil_linked'`);
    assert.equal(linked.rows.length, 1);
    assert.equal(linked.rows[0].company_id, CO);
    const unlinked = await c.query(`SELECT 1 FROM sources WHERE kind = 'filing' AND ref_id = 'fil_unlinked'`);
    assert.equal(unlinked.rows.length, 0);
  });
});

test('only the current, non-superseded fundamentals period is registered, rendered as prose', async () => {
  // A restatement is a new row; the superseded figures are what was believed at the time, not
  // what is worth finding today (lib/company-view.ts and lib/agents/results.ts read the same way).
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const current = await c.query(`SELECT title, content_hash FROM sources WHERE kind = 'fundamentals_period' AND ref_id = 'f_new'`);
    assert.equal(current.rows.length, 1);
    assert.equal(current.rows[0].title, 'Praj Industries Limited, quarter to 2025-03-31');

    const old = await c.query(`SELECT 1 FROM sources WHERE kind = 'fundamentals_period' AND ref_id = 'f_old'`);
    assert.equal(old.rows.length, 0, 'the restated figures are not indexed');

    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE kind = 'fundamentals_period' AND ref_id = 'f_new'`,
    );
    const indexable = await textFor(c, rows[0]!.id);
    assert.equal(
      indexable?.text,
      'Praj Industries Limited, quarter to 2025-03-31: revenue 693.2 cr, PAT 58.1 cr',
    );
    assert.equal(contentHash(indexable!.text), current.rows[0].content_hash, 'textFor must reproduce what was hashed');
  });
});

test('textFor reproduces the exact text a document source was hashed from', async () => {
  await serviceTxn('system:index', async (c) => {
    await registerAll(c);
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
      [DOC_ID],
    );
    const indexable = await textFor(c, rows[0]!.id);
    assert.equal(indexable?.kind, 'document_version');
    assert.equal(indexable?.refId, DOC_ID);
    assert.equal(indexable?.companyId, CO);
    assert.equal(indexable?.text, EXISTING_TEXT);
  });
});

test('a sheet document_version: chunkCells offsets slice back against textFor\'s own output', async () => {
  // Regression test for the citation-offset bug: chunkCells used to compute char_from/char_to into
  // a tab-and-newline grid it built INTERNALLY, while textFor returned the raw JSONB body — two
  // different strings (verified live: a real chunk's char_from=0, char_to=109 sliced the actual
  // source to '{"cells": {"A1": "Revenue FY26 (cr)"…', not to the chunk's own text). chunk.test.ts's
  // own sheet tests never caught this because they compared chunkCells' offsets against the exact
  // string chunkCells itself builds — right by construction, which is why nothing there could ever
  // fail. This compares against textFor's ACTUAL return value instead.
  const docId = 'd_sheet_offsets';
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ($1,$2,'Model','sheet','system:index')`,
      [docId, CO],
    );
    await c.query(`INSERT INTO document_versions (document_id, body, written_by) VALUES ($1, $2, 'system:index')`, [
      docId,
      JSON.stringify({ cells: { A1: 'Revenue FY26 (cr)', B1: '693.2', A2: 'PAT', B2: '58.1' } }),
    ]);
    await registerAll(c);

    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
      [docId],
    );
    const indexable = await textFor(c, rows[0]!.id);
    assert.ok(indexable, 'the sheet must register and resolve');
    assert.ok(indexable!.sheets, 'a sheet body must come back with its parsed tabs, not just text');

    const pieces = chunkCells(indexable!.sheets!);
    assert.ok(pieces.length > 0);
    for (const p of pieces) {
      assert.equal(
        indexable!.text.slice(p.charFrom, p.charTo),
        p.text,
        "a chunk's offsets must slice textFor's own text back to exactly the chunk's own text",
      );
    }
  });
});

test('textFor returns null for a source id that does not exist', async () => {
  await serviceTxn('system:index', async (c) => {
    assert.equal(await textFor(c, '999999999'), null);
  });
});
