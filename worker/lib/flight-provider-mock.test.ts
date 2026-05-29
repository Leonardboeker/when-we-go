// worker/lib/flight-provider-mock.test.ts
// Node native test runner — `node --test worker/lib/flight-provider-mock.test.ts`.
//
// Verifies the deterministic-mock contract from PLAN T-02:
//   - same (origin, destination, depart) → identical results (cache-friendly)
//   - returns >= 3 options + at least one direct
//   - prices are inside the documented per-distance bands
//   - every option marked source:'mock'
//   - provider.name + provider.isReal correct (UI gates DEMO banner on these)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MockFlightProvider } from './flight-provider-mock.ts';

const provider = new MockFlightProvider();

test('provider metadata: name = mock, isReal = false', () => {
  assert.equal(provider.name, 'mock');
  assert.equal(provider.isReal, false);
});

test('deterministic: same input yields identical output across two calls', async () => {
  const input = {
    originIata: 'MUC',
    destinationIata: 'CPH',
    departDate: '2026-07-12',
    returnDate: '2026-07-15',
  };
  const a = await provider.searchFlights(input);
  const b = await provider.searchFlights(input);
  assert.equal(a.reason, 'ok');
  assert.equal(b.reason, 'ok');
  assert.equal(a.flights.length, b.flights.length);
  for (let i = 0; i < a.flights.length; i++) {
    assert.deepEqual(a.flights[i], b.flights[i], `flight #${i} not deterministic`);
  }
});

test('different inputs yield different results', async () => {
  const a = await provider.searchFlights({
    originIata: 'MUC', destinationIata: 'CPH', departDate: '2026-07-12',
  });
  const b = await provider.searchFlights({
    originIata: 'MUC', destinationIata: 'CPH', departDate: '2026-08-15',
  });
  // Same route, different date — different RNG seed → at least one field
  // differs in the cheapest option.
  const A = a.flights[0];
  const B = b.flights[0];
  const allEqual =
    A.carrierCode === B.carrierCode &&
    A.priceEur === B.priceEur &&
    A.departureTimeLocal === B.departureTimeLocal;
  assert.equal(allEqual, false, 'different dates should change the result');
});

test('returns at least 3 options, all marked source:mock, with at least one direct', async () => {
  const r = await provider.searchFlights({
    originIata: 'MUC', destinationIata: 'CPH', departDate: '2026-07-12',
  });
  assert.equal(r.reason, 'ok');
  assert.ok(r.flights.length >= 3, `got ${r.flights.length} flights, want >= 3`);
  for (const f of r.flights) {
    assert.equal(f.source, 'mock', `every option must carry source:'mock'`);
    assert.equal(f.priceCurrency, 'EUR');
    assert.ok(f.priceEur > 0, 'priceEur must be positive');
    assert.ok(f.durationMinTotal > 0, 'duration must be positive');
    assert.ok(f.bookingHint.includes('DEMO'), 'bookingHint must flag DEMO');
  }
  // At least one direct (stops === 0).
  assert.ok(r.flights.some((f) => f.stops === 0), 'expected at least one direct option');
});

test('short-haul price band: MUC→CPH within €30..€350', async () => {
  // Documented 60-250 band — allow ±20% jitter so 30..350 outer envelope.
  const r = await provider.searchFlights({
    originIata: 'MUC', destinationIata: 'CPH', departDate: '2026-07-12',
  });
  for (const f of r.flights) {
    assert.ok(f.priceEur >= 30 && f.priceEur <= 350, `price ${f.priceEur} outside short-haul band`);
  }
});

test('long-haul price band: FRA→SYD within €350..€2000', async () => {
  const r = await provider.searchFlights({
    originIata: 'FRA', destinationIata: 'SYD', departDate: '2026-07-12',
  });
  assert.equal(r.reason, 'ok');
  for (const f of r.flights) {
    assert.ok(f.priceEur >= 350 && f.priceEur <= 2000, `price ${f.priceEur} outside long-haul band`);
  }
});

test('flights sorted cheapest-first', async () => {
  const r = await provider.searchFlights({
    originIata: 'BCN', destinationIata: 'LHR', departDate: '2026-09-01',
  });
  for (let i = 1; i < r.flights.length; i++) {
    assert.ok(r.flights[i - 1].priceEur <= r.flights[i].priceEur, 'price not monotonically increasing');
  }
});

test('missing origin → profile_incomplete (no flights)', async () => {
  const r = await provider.searchFlights({
    originIata: '', destinationIata: 'CPH', departDate: '2026-07-12',
  });
  assert.equal(r.reason, 'profile_incomplete');
  assert.equal(r.flights.length, 0);
});

test('missing destination → destination_unmapped (no flights)', async () => {
  const r = await provider.searchFlights({
    originIata: 'MUC', destinationIata: '', departDate: '2026-07-12',
  });
  assert.equal(r.reason, 'destination_unmapped');
  assert.equal(r.flights.length, 0);
});

test('print first 2 mock options for MUC→CPH 2026-07-12 (determinism check)', async () => {
  const r = await provider.searchFlights({
    originIata: 'MUC', destinationIata: 'CPH', departDate: '2026-07-12', returnDate: '2026-07-15',
  });
  console.log('FIRST_TWO_MUC_CPH_2026-07-12:', JSON.stringify(r.flights.slice(0, 2), null, 2));
  assert.ok(r.flights.length >= 2);
});
