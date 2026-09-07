import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFor, distinctive, mentions, mentionsTerm, nameTerm,
  type CompanyVocabulary, type Item,
} from './match.ts';

const PRAJ: CompanyVocabulary = {
  id: 'c_praj', symbol: 'PRAJIND', isin: 'INE074A01025', name: 'Praj Industries Limited',
  sector: 'bioenergy',
  aliases: [{ alias: 'Praj Hipurity', kind: 'subsidiary' }, { alias: 'BioSyrup', kind: 'brand' }],
  sectorTerms: ['ethanol', 'distillery', 'sugar mill', 'biogas'],
};

const item = (title: string, over: Partial<Item> = {}): Item => ({
  id: 'i1', title, summary: null, sourceSector: null, sourceMarket: 'india', ...over,
});

const tiers = (i: Item) => candidatesFor(i, [PRAJ]).map((c) => `${c.tier}:${c.evidence}`);

// ---- the identifier tiers ----------------------------------------------------------------------

test('a name is stripped down to the part that identifies it', () => {
  assert.equal(distinctive('Praj Industries Limited'), 'Praj');
  assert.equal(distinctive('Tega Industries Limited'), 'Tega');
  // v2's docstring claimed this reduced to "Mobility Hospitality". It does not and never did:
  // "Ecos" is not furniture. Carried forward as measured behaviour rather than as documented.
  assert.equal(distinctive('Ecos (India) Mobility & Hospitality Limited'), 'Ecos Mobility Hospitality');
});

test('a multi-word name matches on its first two words, adjacent', () => {
  // Matching on the first word alone filed a Sterling Wilson story under Sterling Tools.
  assert.equal(nameTerm('Sterling Tools Limited')?.term, 'Sterling Tools');
  assert.ok(nameTerm('Sterling Tools Limited')!.pattern.test('Sterling Tools wins an order'));
  assert.ok(!nameTerm('Sterling Tools Limited')!.pattern.test('Sterling Wilson wins an order'));
  assert.equal(nameTerm('Praj Industries Limited')?.term, 'Praj', 'one distinctive word stands alone');
});

test('vocabulary is bounded at the front only, so plurals are caught', () => {
  // Stories are written in the plural more often than the singular. A closing boundary means
  // "sugar mill" misses "sugar mills" and "distillery" misses "distilleries".
  assert.ok(mentionsTerm('Sugar mills asked to file data', 'sugar mill'));
  assert.ok(mentionsTerm('Two distilleries commissioned', 'distillery') === false
    || mentionsTerm('Two distilleries commissioned', 'distiller'));
  assert.ok(!mentionsTerm('The bioethanol debate', 'ethanol'), 'the leading boundary still holds');
});

test('a match is word-bounded, always', () => {
  // The four-character floor plus boundaries. A five-character floor silently dropped Praj and
  // Tega — two names on an eleven-name book — which is why the floor is not the mechanism.
  assert.ok(mentions('Praj wins an order', 'Praj'));
  assert.ok(!mentions('The ecosystem is growing', 'Ecos'));
  assert.ok(!mentions('Sagarmala port project', 'Sagar'));
  assert.ok(!mentions('a praj', 'prj'), 'below the floor');
});

test('the symbol is matched as written, in capitals', () => {
  assert.deepEqual(tiers(item('PRAJIND hits a 52-week high')), ['symbol:PRAJIND']);
  assert.deepEqual(tiers(item('the prajind of the matter')), [], 'lower case is a word, not a ticker');
});

test('an ISIN counts', () => {
  assert.deepEqual(tiers(item('Allotment under INE074A01025')), ['isin:INE074A01025']);
});

test('subsidiaries and brands come back as themselves', () => {
  // A subsidiary carrying the parent's name is caught by the name tier first, which is not wrong —
  // the company's own name is in the story. The tiers matter for subsidiaries named differently.
  assert.deepEqual(tiers(item('BioSyrup expands its range')), ['brand:BioSyrup']);
  const co = { ...PRAJ, aliases: [{ alias: 'Hipurity Systems', kind: 'subsidiary' }] };
  assert.deepEqual(
    candidatesFor(item('Hipurity Systems commissions a plant'), [co]).map((c) => c.tier),
    ['subsidiary'],
  );
});

test('a story is caught at the narrowest tier that catches it', () => {
  // Both the name and a sector term are present. Telling the gate "sector term" would make it work
  // harder for a worse answer.
  const t = tiers(item('Praj commissions a new ethanol distillery', { sourceSector: 'bioenergy' }));
  assert.deepEqual(t, ['name:Praj']);
});

// ---- the vocabulary tier -----------------------------------------------------------------------

test('a sector term from a matching trade title is a candidate', () => {
  assert.deepEqual(
    tiers(item('Revised CBG pricing to support biogas producers', { sourceSector: 'bioenergy' })),
    ['sector_term:biogas'],
  );
});

test('a sector term from another industry’s title is a coincidence', () => {
  assert.deepEqual(
    tiers(item('Ethanol used in mineral processing', { sourceSector: 'mining' })), [],
  );
});

test('general press carries every industry, so it is not filtered by sector', () => {
  assert.deepEqual(
    tiers(item('Government raises ethanol blending target', { sourceSector: null })),
    ['sector_term:ethanol'],
  );
});

test('a global title’s vocabulary is not about an Indian company', () => {
  // The anchor, asked of the source rather than of the headline. v2 asked the story whether it
  // said "India"; 71 of 135 items from Indian trade titles never do, and it cost two real PRAJIND
  // stories from ChiniMandi.
  assert.deepEqual(
    tiers(item('Brazil expands ethanol capacity', { sourceSector: 'bioenergy', sourceMarket: 'global' })),
    [],
  );
  assert.deepEqual(
    tiers(item('Sugar mills asked to file sales data', { sourceSector: 'bioenergy', sourceMarket: 'india' })),
    ['sector_term:sugar mill'],
    'and the domestic trade title gets through without saying the word India',
  );
});

test('policy with no company in it is still a candidate', () => {
  // A version of this filtered these out on the theory that they gave the gate nothing to reason
  // about. Against 2,084 real items it removed five of six candidates, and the five were CBG
  // pricing and ethanol policy — what this tier is for.
  assert.deepEqual(
    tiers(item('Supreme Court dismisses PIL on ethanol content at petrol pumps')),
    ['sector_term:ethanol'],
  );
});

test('a company with no sector picks up no vocabulary', () => {
  const noSector = { ...PRAJ, sector: null, sectorTerms: [] };
  assert.deepEqual(candidatesFor(item('ethanol blending rises'), [noSector]), []);
});

test('a name that is an ordinary word does not match on its own', () => {
  const supreme: CompanyVocabulary = {
    id: 'c_sup', symbol: 'SUPREME', isin: null, name: 'Supreme Limited', sector: null,
    aliases: [], sectorTerms: [],
  };
  assert.deepEqual(candidatesFor(item('The Supreme Court ruled today'), [supreme]), []);
});
