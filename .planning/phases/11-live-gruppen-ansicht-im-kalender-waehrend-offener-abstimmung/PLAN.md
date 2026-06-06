# Phase 11 — Live-Gruppen-Ansicht im Kalender (offene Abstimmung)

**Status:** planned
**Created:** 2026-06-06

## Goal

Während die Abstimmung **offen** ist, im Kalender pro Tag sehen, wer (welche
Teilnehmer) kann. Heute zeigt der Kalender bei offener Poll nur die *eigenen*
Votes; die Gruppen-Ansicht (`overlap.perDate`) läuft nur nach Poll-Schluss.

## Design-Entscheidungen (vom User bestätigt)

1. **Zellenfarbe = eigene Stimme** (grün/amber/rot) — bleibt unverändert.
2. **Gruppe = Punkte pro Tag** — kleine farbige Punkte (ein Punkt je *anderem*
   Teilnehmer der an dem Tag abgestimmt hat, Farbe = dessen Status yes/maybe/no).
3. **Namen beim Antippen** — Tippt man einen Tag, zeigt ein Toast
   „10. Juli — Papa ✓, Schwester ?, Bruder ✗".
4. **Live** über den bestehenden 30s-Refresh (`refreshState`).
5. **Privacy:** Server gibt Name + State + Datum (KEINE Tokens). Bewusste
   Entscheidung für die Familien-Poll.

## Tasks

- [ ] **T1 Server** `worker/handlers/poll.ts`: `stub.getAllVotes()` (existiert in
      DO) in `Promise.all`. Token→Name via `poll.participants` mappen. Neues
      Feld `groupVotes: { [date]: [{ name, state }] }` in der Response (immer,
      auch offen). Tokens niemals ausgeben.
- [ ] **T2 Client render** `src/pages/[slug]/[token].astro` `applyServerState`:
      aus `data.groupVotes` pro Tag Punkte rendern (andere Teilnehmer, farbig),
      bei offener UND geschlossener Poll. Bei jedem Refresh neu.
- [ ] **T3 Client tap** Toast mit Namen+Status für den getippten Tag
      (bestehendes Toast-Element wiederverwenden).
- [ ] **T4 CSS** `src/components/CalendarGrid.astro`: `.cell-voter-dots` +
      `.voter-dot.is-yes/.is-maybe/.is-no`, dezent unter der Tageszahl.
- [ ] **T5 Verify**: lokal mehrere Teilnehmer abstimmen lassen → Punkte +
      Toast prüfen; Build + `check:inline`; live deployen + im Browser testen.

## Verification

- Mit Votes von ≥2 Teilnehmern erscheinen Punkte am richtigen Tag, richtige Farbe.
- Antippen zeigt Toast mit Namen + Status.
- Punkte aktualisieren sich beim 30s-Refresh.
- Keine Tokens in der API-Response.
- `npm run check:inline` grün (kein IIFE-Bruch).
