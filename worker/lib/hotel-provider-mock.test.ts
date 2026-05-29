// worker/lib/hotel-provider-mock.test.ts
// Node native test runner — `node --test worker/lib/hotel-provider-mock.test.ts`.
//
// Verifies the deterministic-mock contract from PLAN T-02:
//   - same (destinationIata, checkIn, checkOut, guests) → identical results
//   - returns >= 5 options
//   - every option marked source:'mock'
//   - perPerson math = ceil(total / guests), total = nightly × nights
//   - prices scale with nights (3-night stay costs 3× a 1-night stay)
//   - provider.name + provider.isReal correct (UI gates DEMO banner on these)
//   - destination_unmapped reason when no IATA

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MockHotelProvider } from './hotel-provider-mock.ts';

const provider = new MockHotelProvider();

test('provider metadata: name = mock, isReal = false', () => {
  assert.equal(provider.name, 'mock');
  assert.equal(provider.isReal, false);
});

test('deterministic: same input yields identical output across two calls', async () => {
  const input = {
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests: 4,
  };
  const a = await provider.searchHotels(input);
  const b = await provider.searchHotels(input);
  assert.equal(a.reason, 'ok');
  assert.equal(b.reason, 'ok');
  assert.equal(a.hotels.length, b.hotels.length);
  for (let i = 0; i < a.hotels.length; i++) {
    assert.deepEqual(a.hotels[i], b.hotels[i], `hotel #${i} not deterministic`);
  }
});

test('returns at least 5 options, all marked source:mock with sane fields', async () => {
  const r = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests: 4,
  });
  assert.equal(r.reason, 'ok');
  assert.ok(r.hotels.length >= 5, `got ${r.hotels.length} hotels, want >= 5`);
  for (const h of r.hotels) {
    assert.equal(h.source, 'mock', `every option must carry source:'mock'`);
    assert.ok(h.stars >= 1 && h.stars <= 5, `stars ${h.stars} out of range`);
    assert.ok(h.distanceToCenterKm >= 0 && h.distanceToCenterKm <= 10);
    assert.ok(h.totalPriceEur > 0, 'totalPriceEur must be positive');
    assert.ok(h.nightlyPriceEur > 0, 'nightlyPriceEur must be positive');
    assert.ok(h.perPersonEur > 0, 'perPersonEur must be positive');
    assert.ok(Array.isArray(h.amenities) && h.amenities.length >= 1);
    assert.ok(h.amenities.includes('wifi'), 'wifi always present in 2026');
    assert.ok(h.bookingHint.includes('DEMO'), 'bookingHint must flag DEMO');
    assert.ok(typeof h.hotelId === 'string' && h.hotelId.length > 0);
  }
});

test('per-person math: perPersonEur = ceil(totalPriceEur / guests)', async () => {
  const guests = 4;
  const r = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests,
  });
  for (const h of r.hotels) {
    const expected = Math.ceil(h.totalPriceEur / guests);
    assert.equal(h.perPersonEur, expected, `perPerson mismatch for ${h.name}`);
  }
});

test('price scales linearly with nights: 3-night total = nightly × 3', async () => {
  const r = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15', // 3 nights
    guests: 4,
  });
  for (const h of r.hotels) {
    assert.equal(
      h.totalPriceEur,
      h.nightlyPriceEur * 3,
      `total ${h.totalPriceEur} !== nightly ${h.nightlyPriceEur} × 3 for ${h.name}`
    );
  }
});

test('different date ranges produce different results', async () => {
  const a = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests: 4,
  });
  const b = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-08-01',
    checkOutDate: '2026-08-04',
    guests: 4,
  });
  // Same destination, different dates → different RNG seed → at least one
  // hotel name should differ in the cheapest slot.
  const sameFirstName = a.hotels[0].name === b.hotels[0].name &&
    a.hotels[0].totalPriceEur === b.hotels[0].totalPriceEur;
  assert.equal(sameFirstName, false, 'different dates should change the result');
});

test('hotels sorted cheapest-per-person first', async () => {
  const r = await provider.searchHotels({
    destinationIata: 'BCN',
    destinationCity: 'Barcelona',
    checkInDate: '2026-09-01',
    checkOutDate: '2026-09-05',
    guests: 3,
  });
  for (let i = 1; i < r.hotels.length; i++) {
    assert.ok(
      r.hotels[i - 1].perPersonEur <= r.hotels[i].perPersonEur,
      `perPerson not monotonically increasing at #${i}`
    );
  }
});

test('missing destinationIata → destination_unmapped (no hotels)', async () => {
  const r = await provider.searchHotels({
    destinationIata: '',
    destinationCity: 'Whoknows',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests: 4,
  });
  assert.equal(r.reason, 'destination_unmapped');
  assert.equal(r.hotels.length, 0);
});

test('print first 2 mock options for CPH 2026-07-12→07-15 guests=4 (determinism check)', async () => {
  const r = await provider.searchHotels({
    destinationIata: 'CPH',
    destinationCity: 'Copenhagen',
    checkInDate: '2026-07-12',
    checkOutDate: '2026-07-15',
    guests: 4,
  });
  console.log('FIRST_TWO_CPH_2026-07-12_07-15_g4:', JSON.stringify(r.hotels.slice(0, 2), null, 2));
  assert.ok(r.hotels.length >= 2);
});
