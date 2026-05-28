# Phase 3 Context — Polish + Public Release

> Locked decisions for the polish phase: README, banner, OG images, demo deploy, public flip.
> Mirrors pay-me-back's Phase 3 patterns since the goal is identical: turn a working private MVP into a discoverable open-source template.

## Goal

Take when-we-go from "Leo's working private project" → "polished public template anyone can fork and use in 30 min". Same arc as pay-me-back's polish phase.

## Decisions

### V-01 — Banner image
Pixel-art wide banner for the README top, generated via nano-banana. Same aesthetic family as pay-me-back's banner so the two repos visually pair. Composition:
- Left: a small pixel character at a desk with a calendar open
- Center: chunky pixel-font sign "WHEN WE GO"
- Right: 4-5 NES-style icons representing trip-coordination (calendar, plane, suitcase, group of figures, sunset/destination)
- Far right: a pixel HP-bar-style progress indicator showing dates filling in
- Warm sunset palette but with **teal accent** instead of pay-me-back's rust (matches the `--color-primary` swap in global.css)

Saved to `public/banner.png`, referenced in README header.

### V-02 — Per-poll OG preview images
Mirror pay-me-back's approach: build-time PNG per poll via Satori + @resvg/resvg-js.

Each poll gets `dist/og/<slug>.png` (1200×630). Content:
- Top: small "WHEN WE GO" brand mark
- Middle (large): "**<title>**" + "**<destination>**" + "<participantCount> people"
- Bottom: "Polling closes in <N> days" + "TAP TO VOTE →" button

BaseLayout already accepts `ogImage` + `ogDescription` props (ported from pay-me-back). [slug]/[token].astro page passes `/og/<slug>.png`. Adopter just sets `PUBLIC_SITE_URL=https://<their-domain>` at build time to get absolute OG URLs.

Implementation file: `src/pages/og/[slug].png.ts` (same shape as pay-me-back's `src/pages/og/[token].png.ts`).

### D-01 — README structure (mirror pay-me-back's)
1. Banner image
2. Title + tagline + badges (License, Astro 6, Tailwind v4, Cloudflare, TS, "€0/month")
3. **Live demo** button — links straight to a demo poll page
4. Direct links to demo Alice/Bob/Charlie/Admin equivalents (here: 4 participant URLs + 1 admin URL)
5. Constraint blockquote: "This is a coordination tool, not a calendar service. No accounts. Tokens are the only identity."
6. TOC
7. **Five ways to use this** — concrete riffs:
   - Classic group-trip date polling (the Copenhagen story)
   - Wedding date check (couples picking from 2-3 candidate weekends with both families)
   - Annual reunion / Klassentreffen (find the one weekend that works for 12 people)
   - Festival weekend / ski trip (which of these 3 weekends works for our group of 6)
   - Workshop / retreat scheduling (when can the studio team all step away)
8. Stack
9. What you'll need
10. Quick start (local dev)
11. Deploying (Cloudflare)
12. Replacing the pixel art (same nano-banana prompt template pattern as pay-me-back)
13. Open Graph link previews
14. Attribution footer (how to keep/remove)
15. Customising the copy
16. Live demo (how to run your own)
17. Architecture diagram
18. Pre-launch checklist
19. Data retention (port pay-me-back's pattern, adapt to votes vs. debts)
20. Troubleshooting
21. License / Sibling project / Contributing

### D-02 — Demo deployment
Same approach as pay-me-back-demo:
- CF Pages project name: `when-we-go-demo`
- URL: `https://main.when-we-go-demo.pages.dev`
- Production branch: `main`
- Build env vars: `PUBLIC_SITE_URL` + `WHENWEGO_POLLS_JSON` (the Copenhagen example, with placeholder tokens)
- Build flag: `WHENWEGO_DEMO_MODE=true` so the yellow striped banner shows at the top of every page

**Demo data safety:** the example poll already uses placeholder tokens (`EXAMPLE_TOKEN_LEO_REPLACE` etc.) and no real PII. The Telegram pipeline is unset (no `WHENWEGO_TELEGRAM_*` env vars in the demo), so nothing gets pinged. The Worker for the demo is NOT deployed — the demo is static-site-only, so /api/vote will 404 (the calendar JS will fail gracefully and log an error to console). Acceptable for a "see how it looks" demo; mention this in the demo banner copy.

### D-03 — Public flip
After README is polished + demo is live + everything checked:
```bash
gh repo edit Leonardboeker/when-we-go --visibility public --accept-visibility-change-consequences
gh repo edit Leonardboeker/when-we-go --template
```
Plus add topics for discovery (astro, cloudflare, tailwindcss, date-coordination, trip-planning, template, typescript, durable-objects).

### D-04 — Cross-linking
- pay-me-back README already mentions when-we-go (commit `94ae089` from earlier)
- when-we-go's BaseLayout already includes a sibling cross-link footer to pay-me-back (built in Phase 1)
- when-we-go's polished README also mentions pay-me-back in the "Sibling project" section near the end
- No further bidirectional updates needed

### D-05 — Demo data + IBAN-style safety
Apply the same "obviously fake" lesson learned from pay-me-back's demo. Since when-we-go doesn't deal with money, the risk surface is much smaller, but:
- All `EXAMPLE_TOKEN_*_REPLACE` strings stay literal placeholders (clearly fake)
- The example poll has a `pollCloseAt` in the past (or far in the future — pick one consistent with what's helpful for someone trying the demo). **Decision:** set `pollCloseAt` to something in the future (e.g. 2099-12-31) so the demo shows the open-poll UI; people don't need to see the close flow to understand the tool. Mention in the demo banner: "this is a demo, vote interactions log to the browser console but don't persist anywhere."
- No real names, no real destinations beyond "Copenhagen" (which is geographically generic enough that it doesn't dox anyone).

## What Phase 3 explicitly does NOT include

- ❌ Worker deploy for the demo (static site only — keeps the demo cheap + safe; calendar JS will console-error on submit, which is fine for a UI showcase)
- ❌ Multi-language i18n (English only, same as pay-me-back)
- ❌ AI trip suggestions (post-MVP future phase)
- ❌ pay-me-back integration (post-MVP future phase)

## Open questions for after Phase 3

- Should the demo deploy include the Worker too, so the demo is end-to-end clickable? Phase 4+ decision. For now: static demo is enough to sell the idea.
- Real Copenhagen poll deployment for Leo's family — that's Leo's call when he's ready (just runs `npm run gen-poll`, edits `data/polls.json`, deploys his own CF Pages + Worker via `wrangler deploy`).
