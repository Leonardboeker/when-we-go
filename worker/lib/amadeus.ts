// worker/lib/amadeus.ts
// DEPRECATED 2026-05-29 — Amadeus Self-Service portal is being decommissioned
// 2026-07-17. Phase 5 was refactored to a provider-abstracted design
// (`worker/lib/flight-provider.ts` + `worker/lib/flight-provider-mock.ts`).
// No callers import from here anymore. Kept as a stub purely so any cached
// build artefact that still references the path resolves; safe to delete in
// a follow-up cleanup once the new provider impl has shipped to prod.
//
// When a real provider (Kiwi.com Tequila / Skyscanner Rapid / Duffel) is
// chosen, create a new file alongside flight-provider-mock.ts and wire it in
// via the `getFlightProvider(env)` factory.

export {};
