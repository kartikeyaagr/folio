import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, serviceTxn, type Client } from '../db.ts';
import { registerAll } from './register.ts';

/**
 * Retraction tests, split out of register.test.ts (which covers admission — what gets INSERTed and
 * why) once the reap mechanism (lib/retrieval/reap.ts) it exercises grew enough dedicated per-kind
 * tests to earn its own file and its own 300-line budget. Each test here proves one kind's
 * inclusion predicate is correctly COMPLEMENTED — that a row admitted under one condition is
 * retracted once that condition stops holding — not merely that the generic DELETE … NOT EXISTS
 * mechanism runs without crashing. See reap.ts's own top-of-file comment for the full argument; the
 * numbers cited below (4 superseded fundamentals periods, 5 rejected news matches) are measured
 * against the live database 10-Sep-2026, the same evidence that motivated writing this file.
 *
 * A negative closes the suite deliberately: the real risk in generalising a delete is over-deletion,
 * and every symptom of that looks like "search is bad," not "rows were deleted" — so the negative
 * proves a story still confirmed for a second followed company survives even after the first
 * company's match is rejected, which a same-ref_id-per-item DELETE could get wrong in exactly the
 * over-eager direction this suite exists to rule out.
 */

const DB = `trisula_reap_${process.pid}`;
const CO = 'c1'; // Praj Industries Limited — the fund's own name
const CO2 = 'c2'; // a second followed name, for the news re-attribution case

/**
 * Not an existing export — `saveDocument` (lib/workspace.ts) needs a person's writeTxn and always
 * appends unconditionally, which is exactly the behaviour this exercises, so the test gets its own
 * minimal insert rather than a mock of the real one. Mirrors register.test.ts's own helper.
 */
async function saveNewVersion(c: Client, docId: string, text: string): Promise<void> {
  await c.query(
    `INSERT INTO document_versions (document_id, body, written_by) VALUES ($1, $2, 'system:index')`,
    [docId, JSON.stringify({ text })],
  );
}

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();

  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'PRAJIND','Praj Industries Limited')", [CO]);
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'SECOND','Second Followed Co')", [CO2]);
    // Shared by every news fixture below — news_items.source_key references this.
    await c.query(
      "INSERT INTO news_sources (key,label,url,tier,market) VALUES ('src','A wire','https://x/f',1,'india')",
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

test('archiving a previously-registered document retracts its source and chunks', async () => {
  // documents.archived_at is a soft delete — the row always stays — but DOCUMENTS_SELECT's WHERE
  // only stops a future registration; it cannot undo one already done. This proves the other half:
  // registerAll must actively retract a sources row (and, via the FK cascade in 0041, its chunks)
  // once the document behind it is archived, or a withdrawn memo would keep surfacing in search
  // forever. The original, single-kind fix this file's generalisation grew out of.
  const docId = 'd_to_archive';
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, created_by) VALUES ($1,$2,'To be archived','system:index')`,
      [docId, CO],
    );
    await saveNewVersion(c, docId, 'a note about the auditor, later withdrawn');
    await registerAll(c);

    const { rows: registered } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
      [docId],
    );
    assert.equal(registered.length, 1, 'the document registers while active');
    const sourceId = registered[0]!.id;

    // A chunk hanging off the source, so the assertion below proves the FK cascade actually fires
    // and not merely that the sources row's own WHERE was satisfied.
    await c.query(
      `INSERT INTO chunks (source_id, company_id, ord, text, char_from, char_to)
       VALUES ($1, $2, 0, 'a note about the auditor', 0, 24)`,
      [sourceId, CO],
    );

    await c.query('UPDATE documents SET archived_at = now() WHERE id = $1', [docId]);
    await registerAll(c);

    const { rows: afterArchiving } = await c.query(
      `SELECT 1 FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
      [docId],
    );
    assert.equal(afterArchiving.length, 0, 'an archived document is withdrawn, not merely skipped going forward');

    const { rows: orphanedChunks } = await c.query(`SELECT 1 FROM chunks WHERE source_id = $1`, [sourceId]);
    assert.equal(orphanedChunks.length, 0, 'its chunks must not outlive the source that owned them');
  });
});

test('a fundamentals period superseded after being registered is retracted', async () => {
  // The live case this file's generalisation exists for (measured 10-Sep-2026: 4 such rows already
  // sit in `sources` today). A restatement (0008) sets superseded_by on the old row without
  // deleting it, so a period that was current when registered must stop being retrievable as
  // current the moment it is superseded — a restated revenue figure staying searchable as though
  // still true is the exact failure agent 1 and costUsd's null-not-zero convention both exist to
  // avoid.
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, revenue, profit_after_tax)
       VALUES ('f_live',$1,'consolidated','2025-04-01','2025-06-30','quarter',$2,$3)`,
      [CO, 700 * 1e7, 60 * 1e7],
    );
    await registerAll(c);
    const { rows: current } = await c.query(
      `SELECT 1 FROM sources WHERE kind = 'fundamentals_period' AND ref_id = 'f_live'`,
    );
    assert.equal(current.length, 1, 'registers while current');

    // Order matters: fundamentals_period_idx is a partial unique index on (company_id, basis,
    // period_start, period_end) WHERE superseded_by IS NULL, so both rows can never be "current" at
    // once. 0008 makes the superseded_by FK DEFERRABLE INITIALLY DEFERRED for exactly this reason —
    // the UPDATE below is legal only because it runs before the new row exists, checked at commit —
    // the same order lib/ingest/fundamentals.ts's own restatement write already uses.
    await c.query(`UPDATE fundamentals SET superseded_by = 'f_live_restated' WHERE id = 'f_live'`);
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, revenue, profit_after_tax)
       VALUES ('f_live_restated',$1,'consolidated','2025-04-01','2025-06-30','quarter',$2,$3)`,
      [CO, 705 * 1e7, 61 * 1e7],
    );
    await registerAll(c);

    const { rows: superseded } = await c.query(
      `SELECT 1 FROM sources WHERE kind = 'fundamentals_period' AND ref_id = 'f_live'`,
    );
    assert.equal(superseded.length, 0, 'a superseded period must not remain retrievable as current');
  });
});

test('a news match rejected after being confirmed is retracted', async () => {
  // Measured 10-Sep-2026: 5 matches already sit at `rejected` after once being `confirmed`. A
  // candidate the gate later found no mechanism for is not the fund's knowledge (the same rule
  // NEWS_SELECT already applies to a never-confirmed candidate) and must not keep surfacing in
  // search just because it once passed.
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title)
       VALUES ('n_reconsidered','src','n_reconsidered','https://x/4','A story later found unconnected')`,
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m_reconsidered','n_reconsidered',$1,'name','matched on registered name','confirmed','initially thought related')`,
      [CO],
    );
    await registerAll(c);
    const { rows: confirmed } = await c.query(
      `SELECT 1 FROM sources WHERE kind = 'news_item' AND ref_id = 'n_reconsidered'`,
    );
    assert.equal(confirmed.length, 1, 'registers while confirmed');

    await c.query(`UPDATE news_matches SET state = 'rejected' WHERE id = 'm_reconsidered'`);
    await registerAll(c);

    const { rows: rejected } = await c.query(
      `SELECT 1 FROM sources WHERE kind = 'news_item' AND ref_id = 'n_reconsidered'`,
    );
    assert.equal(rejected.length, 0, 'a rejected match is not the fund\'s knowledge and must not stay searchable');
  });
});

test('a confirmed match for a second company is not reaped when the first is rejected', async () => {
  // The over-deletion risk the news reap must not introduce. ref_id for news_item is the ITEM, not
  // the (item, company) pair (NEWS_SELECT), so a story still confirmed for ANY followed company
  // must survive even after one of its confirming matches is rejected. Fixture is local to this
  // test (unlike register.test.ts's equivalent n_two/m3/m4, shared there with an admission test
  // that also needs it) since nothing else in this file touches it.
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title)
       VALUES ('n_two_reap','src','n_two_reap','https://x/5','A story naming both followed names')`,
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m3_reap','n_two_reap',$1,'name','named directly','confirmed','both named as counterparties')`,
      [CO],
    );
    await c.query(
      `INSERT INTO news_matches (id, item_id, company_id, tier, evidence, state, mechanism)
       VALUES ('m4_reap','n_two_reap',$1,'name','named directly','confirmed','both named as counterparties')`,
      [CO2],
    );

    await registerAll(c);
    const { rows: initial } = await c.query(
      `SELECT company_id FROM sources WHERE kind = 'news_item' AND ref_id = 'n_two_reap'`,
    );
    assert.equal(initial.length, 1);
    assert.equal(initial[0]!.company_id, CO, 'tie-break picked the lower company_id while both are confirmed');

    await c.query(`UPDATE news_matches SET state = 'rejected' WHERE id = 'm3_reap'`); // CO's match

    await registerAll(c);

    const { rows: after } = await c.query(
      `SELECT company_id FROM sources WHERE kind = 'news_item' AND ref_id = 'n_two_reap'`,
    );
    assert.equal(after.length, 1, 'CO2 is still confirmed for this item — it must not be reaped');
    assert.equal(after[0]!.company_id, CO2, 'company_id re-attributes to the surviving confirmed match');
  });
});
