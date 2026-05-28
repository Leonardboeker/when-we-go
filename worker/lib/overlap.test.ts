// worker/lib/overlap.test.ts
// node --test compatible unit tests for computeOverlap.
// Run via: node --test worker/lib/overlap.test.ts
//
// We use TS via node's --experimental-strip-types or via a JS shim; node 22+
// can run TS test files when invoked with --import tsx (or with .ts loader).
// To stay lock-free + repo-portable, we keep this as plain TS that node 22.6+
// will type-strip natively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOverlap, type VoteRow } from './overlap.ts';
import type { Poll } from './polls-config.ts';

function mkPoll(participants: number, start: string, end: string): Poll {
  return {
    slug: 'test',
    title: 'Test poll',
    dateRangeStart: start,
    dateRangeEnd: end,
    pollCloseAt: '2099-01-01T00:00:00Z',
    organizerToken: 'org',
    participants: Array.from({ length: participants }, (_, i) => ({
      token: `t${i + 1}`,
      name: `P${i + 1}`,
    })),
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function yesAll(poll: Poll, date: string): VoteRow[] {
  return poll.participants.map((p) => ({ token: p.token, date, state: 'yes' as const }));
}

test('overlap: all-yes single date -> all dates with votes are in perfect', () => {
  const poll = mkPoll(3, '2026-06-01', '2026-06-01');
  const votes = yesAll(poll, '2026-06-01');
  const r = computeOverlap(poll, votes);
  assert.deepEqual(r.perfect, ['2026-06-01']);
  assert.deepEqual(r.withEffort, []);
  assert.deepEqual(r.oneShort, []);
  assert.equal(r.perDate['2026-06-01'].yes, 3);
  assert.equal(r.perDate['2026-06-01'].unvoted, 0);
});

test('overlap: all-no -> all tiers empty + unvoted=0', () => {
  const poll = mkPoll(3, '2026-06-01', '2026-06-01');
  const votes: VoteRow[] = poll.participants.map((p) => ({
    token: p.token,
    date: '2026-06-01',
    state: 'no' as const,
  }));
  const r = computeOverlap(poll, votes);
  assert.equal(r.perfect.length, 0);
  assert.equal(r.withEffort.length, 0);
  assert.equal(r.oneShort.length, 0);
  assert.equal(r.perDate['2026-06-01'].no, 3);
  assert.equal(r.perDate['2026-06-01'].unvoted, 0);
});

test('overlap: empty input -> unvoted=participantCount everywhere', () => {
  const poll = mkPoll(4, '2026-06-01', '2026-06-03');
  const r = computeOverlap(poll, []);
  assert.equal(Object.keys(r.perDate).length, 3);
  for (const d of Object.keys(r.perDate)) {
    assert.equal(r.perDate[d].yes, 0);
    assert.equal(r.perDate[d].maybe, 0);
    assert.equal(r.perDate[d].no, 0);
    assert.equal(r.perDate[d].unvoted, 4);
  }
  assert.equal(r.ranges.length, 0);
});

test('overlap: range merging — 3 consecutive perfect days = 1 range length 3', () => {
  const poll = mkPoll(2, '2026-06-01', '2026-06-05');
  const votes: VoteRow[] = [];
  for (const d of ['2026-06-01', '2026-06-02', '2026-06-03']) {
    votes.push(...yesAll(poll, d));
  }
  const r = computeOverlap(poll, votes);
  assert.equal(r.perfect.length, 3);
  assert.equal(r.ranges.length, 1);
  assert.deepEqual(r.ranges[0], {
    start: '2026-06-01',
    end: '2026-06-03',
    tier: 'perfect',
    length: 3,
  });
});

test('overlap: range break — yes yes _ yes yes = two length-2 ranges', () => {
  const poll = mkPoll(2, '2026-06-01', '2026-06-05');
  const votes: VoteRow[] = [
    ...yesAll(poll, '2026-06-01'),
    ...yesAll(poll, '2026-06-02'),
    // 2026-06-03 has no votes (unvoted tier = null)
    ...yesAll(poll, '2026-06-04'),
    ...yesAll(poll, '2026-06-05'),
  ];
  const r = computeOverlap(poll, votes);
  assert.equal(r.perfect.length, 4);
  assert.equal(r.ranges.length, 2);
  // Both length-2, sorted ascending by start (after tier+length tiebreak)
  assert.equal(r.ranges[0].length, 2);
  assert.equal(r.ranges[1].length, 2);
  assert.deepEqual(
    r.ranges.map((x) => x.start).sort(),
    ['2026-06-01', '2026-06-04']
  );
});

test('overlap: one holdout (one no) -> oneShort tier, not perfect', () => {
  const poll = mkPoll(4, '2026-06-01', '2026-06-01');
  const votes: VoteRow[] = [
    { token: 't1', date: '2026-06-01', state: 'yes' },
    { token: 't2', date: '2026-06-01', state: 'yes' },
    { token: 't3', date: '2026-06-01', state: 'yes' },
    { token: 't4', date: '2026-06-01', state: 'no' },
  ];
  const r = computeOverlap(poll, votes);
  assert.deepEqual(r.perfect, []);
  assert.deepEqual(r.oneShort, ['2026-06-01']);
});

test('overlap: withEffort tier when yes+maybe == participantCount and >=1 maybe', () => {
  const poll = mkPoll(3, '2026-06-01', '2026-06-01');
  const votes: VoteRow[] = [
    { token: 't1', date: '2026-06-01', state: 'yes' },
    { token: 't2', date: '2026-06-01', state: 'yes' },
    { token: 't3', date: '2026-06-01', state: 'maybe' },
  ];
  const r = computeOverlap(poll, votes);
  assert.deepEqual(r.perfect, []);
  assert.deepEqual(r.withEffort, ['2026-06-01']);
  assert.deepEqual(r.oneShort, []);
});

test('overlap: sort order — perfect ranges first, longest first, start ASC tiebreak', () => {
  const poll = mkPoll(2, '2026-06-01', '2026-06-15');
  const votes: VoteRow[] = [];
  // Perfect range: 2026-06-01..2026-06-02 (length 2)
  votes.push(...yesAll(poll, '2026-06-01'));
  votes.push(...yesAll(poll, '2026-06-02'));
  // OneShort range: 2026-06-05..2026-06-08 (length 4)
  for (const d of ['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08']) {
    votes.push({ token: 't1', date: d, state: 'yes' });
    votes.push({ token: 't2', date: d, state: 'no' });
  }
  const r = computeOverlap(poll, votes);
  // Perfect (length 2) should come BEFORE oneShort (length 4) per tier weighting.
  assert.equal(r.ranges[0].tier, 'perfect');
  assert.equal(r.ranges[1].tier, 'oneShort');
  assert.equal(r.ranges[1].length, 4);
});
