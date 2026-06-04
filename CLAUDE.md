# CLAUDE.md — when-we-go

## Aktives Projekt

Dies ist das **aktiv entwickelte Projekt**. PayLeo ist abgeschlossen — PayLeo NICHT anfassen, niemals weiter daran arbeiten.

## Projektkontext

**when-we-go** ist ein Group-Trip-Planner:
- Teilnehmer stimmen über Reisedaten ab (Kalender-Grid)
- Nach Poll-Close: Flug-, Hotel- und Aktivitätenvorschläge
- Stack: Astro 6 + Tailwind v4 + Cloudflare Pages + Worker + Durable Object

**Live-Demo:** `https://when-we-go-demo.pages.dev`  
**Worker API:** `https://when-we-go-api.ancient-base-f94c.workers.dev`  
**Stitch-Projekt:** `7895610541040632475` (Vorlage für alle UI-Entscheidungen)

## Design-System (Google Stitch)

Das Stitch-Projekt `7895610541040632475` ("when-we-go — Modern Trip Planner") ist die **einzige Design-Vorlage**. Alle UI-Entscheidungen orientieren sich daran.

- Primary: Ocean Blue `#0066cc`
- Accent: Sunset Orange `#f97316`
- Background: `#f0f4f8` (cool blue-gray)
- Cards: weiß + `box-shadow`, `border-radius: 16px`
- Fonts: **Bricolage Grotesque** (Headlines) + **DM Sans** (Body) + **IBM Plex Sans** (Labels)
- Rundungen: 8px Zellen, 10px Cards, 16px Sections
- Abstimmungs-States: 🟢 Grün (Ja) / 🟡 Amber (Vielleicht) / 🔴 Rot-Tint (Nein)

## Workflow

- Alle Änderungen via GSD oder direkt — kein Umweg über andere Projekte
- Vor jeder UI-Änderung: Stitch-Design als Referenz consulten (MCP verfügbar)
- Build: `cd C:\dev\when-we-go && npm run build`
- Lokale Vorschau: `npm run preview -- --port 4399`
- Push: direkt `git push origin main` (triggert CF Pages Deploy)

## Was NICHT zu tun ist

- ❌ PayLeo anfassen (abgeschlossen, deployed, fertig)
- ❌ Pixel-Art/retro Stil zurückbringen
- ❌ `border: 3px solid` / `box-shadow: 4px 4px 0` (alter Pixel-Stil)
- ❌ Monospace-Fonts für regulären Body-Text
- ❌ Warme Creme-Töne (`#fff8ef` etc.) als Hintergrund
