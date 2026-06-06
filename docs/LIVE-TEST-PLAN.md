# Live-Test-Plan — when-we-go (Poll `kopenhagen-2026`)

> Ziel: Jeden Schritt der echten Reise einmal live durchspielen und prüfen, dass
> alles funktioniert, echte Daten kommen und (bei Poll-Schluss) E-Mails rausgehen.
> Reihenfolge einhalten. Jeder Schritt hat **Tun** und **Erwartung (✓ = bestanden)**.

Konstanten für dieses Poll:

```
Worker-API : https://when-we-go-api.ancient-base-f94c.workers.dev
Seite      : https://when-we-go-demo.pages.dev
Slug       : kopenhagen-2026
Organizer  : <ORGANIZER_TOKEN>     (X-Organizer-Token, geheim halten)

Links (1 pro Person):
  Leo       /kopenhagen-2026/<LEO_TOKEN>/
  Schwester /kopenhagen-2026/<SCHWESTER_TOKEN>/
  Papa      /kopenhagen-2026/<PAPA_TOKEN>/
  Bruder    /kopenhagen-2026/<BRUDER_TOKEN>/
```

---

## Teil 0 — Was ist JETZT echt vs. Mock

Stand: nur `WHENWEGO_POLLS_JSON` gesetzt, sonst keine Keys.

| Bereich | Status | Wird echt mit |
|---|---|---|
| Abstimmen, Kalender, **Live-Gruppen-Ansicht** | ✅ ECHT | — |
| Wetter (Reise-Fenster) | ✅ ECHT (Open-Meteo, kein Key) | — |
| Hotels | ✅ ECHT (echte Hotels + echte Booking-Links, **keine** Live-Preise) | — |
| Flüge | ⚠️ MOCK (DEMO-Banner) + echter Google-Flights-Link | `WHENWEGO_KIWI_API_KEY` |
| Aktivitäten / Tipps | ⚠️ MOCK (Evergreen-Liste) | `WHENWEGO_ANTHROPIC_API_KEY` |
| **E-Mail bei Poll-Schluss** | ❌ geht NICHT raus | `WHENWEGO_RESEND_API_KEY` + `WHENWEGO_RESEND_FROM` |
| Push-Benachrichtigung | ❌ aus | `WHENWEGO_VAPID_*` |

**Fazit:** Für „echte Daten + E-Mails" brauchst du mindestens **Resend** (E-Mail).
Kiwi (Flüge) und Anthropic (Aktivitäten) sind optional — ohne sie ist klar als
DEMO/Mock markiert, der Rest der App ist trotzdem echt.

> API-Keys setzt **du** selbst (ich gebe keine Keys/Tokens irgendwo ein). Befehle unten.

---

## Teil 1 — Keys setzen (für echte Daten + E-Mail)

Jeder Befehl im Projektordner `C:\dev\when-we-go`. Nach `secret put` fragt wrangler
nach dem Wert (einfügen + Enter). Worker wird automatisch neu deployt.

### 1a. E-Mail (Resend) — PFLICHT für den E-Mail-Test
1. Account: https://resend.com (Free-Tier). **Domain verifizieren** (du hast
   `leonardboeker.de` schon für PayLeo — dieselbe Domain reicht). Ohne verifizierte
   Domain kann Resend nur an deine eigene Adresse senden, nicht an Papa/Schwester.
2. API-Key erstellen, dann:
   ```bash
   npx wrangler secret put WHENWEGO_RESEND_API_KEY
   npx wrangler secret put WHENWEGO_RESEND_FROM     # z.B. when-we-go <hallo@leonardboeker.de>
   ```
3. ✓ Prüfen: `npx wrangler secret list` zeigt beide Namen.

### 1b. Flüge echt (Kiwi/Tequila) — optional
1. Free-Key: https://tequila.kiwi.com/portal/login
2. `npx wrangler secret put WHENWEGO_KIWI_API_KEY`
3. ✓ Im Trip-Tab verschwindet später der „DEMO"-Banner über den Flügen.

### 1c. Aktivitäten echt (Anthropic) — optional
1. Key: https://console.anthropic.com
2. `npx wrangler secret put WHENWEGO_ANTHROPIC_API_KEY`
3. ✓ Aktivitäten sind dann CPH-spezifisch/aktuell statt Evergreen.

---

## Teil 2 — Sauberer Start (0/4)

**Tun:** Test-Daten löschen (votes + Zähler + Profile):
```bash
curl -X POST "https://when-we-go-api.ancient-base-f94c.workers.dev/api/admin/wipe?slug=kopenhagen-2026&confirm=DELETE" -H "X-Organizer-Token: <ORGANIZER_TOKEN>"
```
**✓ Erwartung:** JSON `{"ok":true,"wiped":true,...}`. Danach zeigt jeder Link
einen leeren Kalender und „0 von 4 haben abgestimmt".

---

## Teil 3 — Durchlauf Schritt für Schritt

### Schritt 3.1 — Abstimmen (jede Person)
**Tun:** Öffne nacheinander alle 4 Links (am besten auf echten Geräten/Handys der
Familie, oder 4 Browser-Tabs/Inkognito). Pro Link ein paar Tage tippen
(Ja/Vielleicht/Nein durch mehrfaches Tippen).
**✓ Erwartung:**
- Tippen färbt die Zelle sofort (grün/amber/rot), Status „Gespeichert ✓".
- Auf den ANDEREN Links erscheinen nach ≤30 s **Punkte** an den getippten Tagen.
- Tippt man einen Tag, zeigt der Toast „<Datum> — Name ✓/?/✗, …".
- Header-Zähler steigt: „1 von 4 … 4 von 4 (100%)".

### Schritt 3.2 — Profil/E-Mail pro Person (nötig für Close-Mail)
**Tun:** Auf jedem Link unten **Profil** öffnen → echte E-Mail + Heimatflughafen
eintragen → Speichern. (Heimatflughafen treibt die Flug-Suchlinks.)
**✓ Erwartung:** „Gespeichert". Mind. die E-Mail ist gesetzt (sonst keine Close-Mail
an die Person).

### Schritt 3.3 — Kommentare (optional)
**Tun:** Auf einem Link eine Notiz zu einem Tag schreiben („kann nur abends").
**✓ Erwartung:** Notiz erscheint, auf anderen Links nach Refresh sichtbar.

### Schritt 3.4 — Poll schließen (Test: sofort statt 20. Juni)
**Tun:** Force-Close als Organizer:
```bash
curl -X POST "https://when-we-go-api.ancient-base-f94c.workers.dev/api/admin/close?slug=kopenhagen-2026" -H "X-Organizer-Token: <ORGANIZER_TOKEN>"
```
**✓ Erwartung:** JSON ok. Auf den Links: Banner „Abstimmung beendet · Beste Daten:
… → …", Kalender read-only, automatischer Wechsel zum **Reise**-Tab.

### Schritt 3.5 — E-Mail-Versand prüfen  ← Kern deines Misstrauens
**Tun:** In die echten Postfächer schauen (die du in 3.2 gesetzt hast).
**✓ Erwartung (nur mit Resend-Key aus 1a):** Jede Person bekommt eine
Close-Summary-Mail mit dem besten Datum + Add-to-Calendar/iCal-Anhang.
**✗ Ohne Resend-Key:** Es kommt NICHTS (kein Fehler, still übersprungen) — dann
ist 1a nicht erledigt.
Falls nichts ankommt trotz Key: Worker-Logs live ansehen:
```bash
npx wrangler tail
```
und erneut schließen (3.4 nach reopen 3.8), auf Resend-Antwort/Statuscode achten.

### Schritt 3.6 — Reise-Tab: echte Daten prüfen
**Tun:** Reise-Tab auf einem Link öffnen.
**✓ Erwartung:**
- **Flüge:** mit Kiwi-Key (1b) echte Preise BER/… → CPH, ohne Key MOCK mit „DEMO".
  Der „auf Google Flights suchen"-Link ist immer echt.
- **Hotels:** echte Kopenhagen-Hotels mit funktionierenden Booking.com-Links
  (Villa Copenhagen, Nimb, SP34 …). Preise „live"/unbekannt, das ist gewollt.
- **Aktivitäten:** mit Anthropic-Key (1c) CPH-spezifisch, sonst Evergreen.
- **Wetter:** echte historische Wetterwerte fürs Reise-Fenster.
- **Add-to-Calendar / .ics:** Button lädt eine .ics, die sich im Kalender öffnen lässt.

### Schritt 3.7 — Daten-Integrität (was wirklich gespeichert ist)
**Tun:** Kompletten Datenbestand als JSON ziehen:
```bash
curl "https://when-we-go-api.ancient-base-f94c.workers.dev/api/admin/export?slug=kopenhagen-2026" -H "X-Organizer-Token: <ORGANIZER_TOKEN>"
```
**✓ Erwartung:** Votes, Profile (echte Mails), Kommentare stimmen mit dem überein,
was ihr getippt habt. Keine Fremd-/Fantasiedaten.

### Schritt 3.8 — Wieder öffnen (um erneut zu testen)
```bash
curl -X POST "https://when-we-go-api.ancient-base-f94c.workers.dev/api/admin/reopen?slug=kopenhagen-2026" -H "X-Organizer-Token: <ORGANIZER_TOKEN>"
```
**✓ Erwartung:** Poll ist wieder offen, abstimmbar.

---

## Teil 4 — Vor dem echten Familien-Versand

1. **Finaler Wipe** (Teil 2) → echter 0/4-Start.
2. Sicherstellen: `pollCloseAt` (aktuell 2026-06-20) passt, sonst schließt der Cron
   zu früh/spät. (Liegt in `WHENWEGO_POLLS_JSON` → bei Bedarf neu setzen.)
3. Links einzeln & gezielt verschicken (jeder Link = eine Person).

---

## Schnell-Checkliste

- [ ] 1a Resend-Key + FROM gesetzt (sonst keine Mails)
- [ ] 1b Kiwi-Key (optional, echte Flugpreise)
- [ ] 1c Anthropic-Key (optional, echte Aktivitäten)
- [ ] 2 Wipe → 0/4
- [ ] 3.1 Abstimmen + Live-Punkte + Toast + Zähler
- [ ] 3.2 echte E-Mails in Profilen
- [ ] 3.4 Force-Close → „beste Daten"-Banner
- [ ] 3.5 Close-Mails in echten Postfächern
- [ ] 3.6 Reise-Tab: Flüge/Hotels/Aktivitäten/Wetter/iCal
- [ ] 3.7 Export-Check (echte Daten)
- [ ] 4 finaler Wipe vor Versand
