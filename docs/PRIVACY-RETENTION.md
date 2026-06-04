# Datenschutz & Aufbewahrung (DSGVO)

> Kurz-Leitfaden für Organisator:innen. when-we-go speichert pro Umfrage
> **personenbezogene Daten** (Namen, E-Mail-Adressen, Heimatflughafen,
> Verfügbarkeiten). Geh damit verantwortungsvoll um.

## Welche Daten gespeichert werden

Pro Umfrage, im Durable Object (Cloudflare, EU-Region wenn so konfiguriert):

| Daten | Quelle | Zweck |
|---|---|---|
| Name | `WHENWEGO_POLLS_JSON` | Anzeige auf der persönlichen Seite |
| E-Mail | Profil-Formular | Reise-Infos + Erinnerungs-Mails |
| Heimatflughafen / -stadt | Profil-Formular | Flug-Suchlinks |
| Budget, Interessen | Profil-Formular (optional) | Personalisierung |
| Verfügbarkeiten (Ja/Vielleicht/Nein) | Kalender | Termin-Findung |

**Keine** Zahlungsdaten. **Keine** Tracker/Analytics. Seiten sind `noindex`.

## Rechtsgrundlage

Privater, einmaliger Reise-Planungs-Zweck unter Freund:innen/Familie. Hol
**vor dem Versand der Links** das (formlose) Einverständnis der Teilnehmenden
ein — sie wissen, dass Name + E-Mail + Verfügbarkeit gespeichert werden.

## Export (Auskunft / Portabilität)

Admin-Dashboard → **„Daten exportieren"** → lädt eine vollständige JSON-Datei
mit allen gespeicherten Daten herunter (`/api/admin/export`).

## Löschung (Recht auf Vergessenwerden)

Admin-Dashboard → **„Daten löschen"** (doppelte Bestätigung) → löscht **alle**
Daten dieser Umfrage unwiderruflich (`/api/admin/wipe?confirm=DELETE`).

**Empfehlung:** Nach der Reise (z. B. **+14 Tage**) einmal exportieren (falls
du etwas behalten willst) und dann löschen. Trag dir dafür einen Kalender-
Eintrag ein.

## Hosting-seitige Löschung (optional, gründlicher)

Der Durable-Object-Storage lässt sich pro Umfrage auch via Wrangler entfernen,
falls du auf Nummer sicher gehen willst:

```bash
# Listet DO-Instanzen (eine pro Umfrage-slug)
npx wrangler durable-objects namespace list
# Detail-Schritte: siehe Cloudflare-Docs „Durable Objects → delete".
```

Der `Daten löschen`-Button leert bereits alle Tabellen der Instanz — das
reicht für den DSGVO-Löschanspruch.
