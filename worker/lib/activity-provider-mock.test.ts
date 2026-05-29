// worker/lib/activity-provider-mock.test.ts
// Node native test runner — `node --test worker/lib/activity-provider-mock.test.ts`.
//
// Verifies the deterministic-mock contract from PLAN T-03:
//   - same (destination, start, end, count) → identical results
//   - both tiers (thisWeek, alwaysGreat) are populated
//   - every item carries source:'mock'
//   - provider metadata correct (UI gates DEMO banner on isReal === false)
//   - curated destinations get destination-specific evergreens
//   - empty destination → destination_too_obscure

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MockActivityProvider } from './activity-provider-mock.ts';

const provider = new MockActivityProvider();

test('provider metadata: name = mock, isReal = false', () => {
  assert.equal(provider.name, 'mock');
  assert.equal(provider.isReal, false);
});

test('deterministic: same input yields identical output across two calls', async () => {
  const input = {
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  };
  const a = await provider.fetchActivities(input);
  const b = await provider.fetchActivities(input);
  assert.equal(a.reason, 'ok');
  assert.equal(b.reason, 'ok');
  assert.deepEqual(a.activities, b.activities, 'activities not deterministic');
});

test('both tiers populated + all items marked source:mock with sane fields', async () => {
  const r = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  assert.equal(r.reason, 'ok');
  assert.ok(
    r.activities.thisWeek.length >= 1,
    `thisWeek empty (${r.activities.thisWeek.length})`
  );
  assert.ok(
    r.activities.alwaysGreat.length >= 3,
    `alwaysGreat short (${r.activities.alwaysGreat.length})`
  );
  const all = [...r.activities.thisWeek, ...r.activities.alwaysGreat];
  for (const item of all) {
    assert.equal(item.source, 'mock', `every item must carry source:'mock'`);
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
    assert.ok(item.name.length <= 80, `name > 80 chars: ${item.name}`);
    assert.ok(
      ['high', 'medium', 'low'].includes(item.confidence),
      `bad confidence: ${item.confidence}`
    );
    assert.ok(typeof item.paid === 'boolean');
    assert.ok(item.whyOneSentence.length > 0);
    assert.ok(item.whyOneSentence.length <= 200);
  }
});

test('curated destination (Copenhagen) returns Copenhagen-specific evergreens', async () => {
  const r = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  const names = r.activities.alwaysGreat.map((a) => a.name.toLowerCase()).join(' | ');
  // Should mention at least one canonical Copenhagen landmark.
  const hit =
    names.includes('tivoli') ||
    names.includes('nyhavn') ||
    names.includes('christiania') ||
    names.includes('louisiana');
  assert.ok(hit, `expected Copenhagen-specific name in: ${names}`);
});

test('different destinations produce different evergreens', async () => {
  const a = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  const b = await provider.fetchActivities({
    destination: 'Barcelona, Spain',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  const aFirst = a.activities.alwaysGreat[0]?.name ?? '';
  const bFirst = b.activities.alwaysGreat[0]?.name ?? '';
  assert.notEqual(aFirst, bFirst, 'different destinations should differ');
});

test('alwaysGreat items default to confidence:high (evergreens are reliable)', async () => {
  const r = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  for (const item of r.activities.alwaysGreat) {
    assert.equal(
      item.confidence,
      'high',
      `evergreen ${item.name} should be high-confidence`
    );
  }
});

test('thisWeek items get confidence:medium (fabricated dates)', async () => {
  const r = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  for (const item of r.activities.thisWeek) {
    assert.equal(
      item.confidence,
      'medium',
      `thisWeek ${item.name} should be medium-confidence`
    );
  }
});

test('empty destination → destination_too_obscure (no activities)', async () => {
  const r = await provider.fetchActivities({
    destination: '',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  assert.equal(r.reason, 'destination_too_obscure');
  assert.equal(r.activities.thisWeek.length, 0);
  assert.equal(r.activities.alwaysGreat.length, 0);
});

test('unknown destination falls back to generic template (still 6 alwaysGreat)', async () => {
  const r = await provider.fetchActivities({
    destination: 'Tuvalu',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  assert.equal(r.reason, 'ok');
  assert.equal(
    r.activities.alwaysGreat.length,
    6,
    'generic template should always emit 6 items'
  );
});

test('print first 2 alwaysGreat for Copenhagen (sanity log)', async () => {
  const r = await provider.fetchActivities({
    destination: 'Copenhagen, Denmark',
    startDate: '2026-07-12',
    endDate: '2026-07-15',
    participantCount: 4,
  });
  console.log(
    'FIRST_TWO_CPH_ACTIVITIES:',
    JSON.stringify(r.activities.alwaysGreat.slice(0, 2), null, 2)
  );
  assert.ok(r.activities.alwaysGreat.length >= 2);
});
