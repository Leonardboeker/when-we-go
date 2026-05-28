# Phase 3 Plan — Polish + Public Release

> Atomic tasks for polishing the project + publishing. Mirrors pay-me-back's Phase 3 closely.

## Tasks

### T-01 — Generate banner image (nano-banana)
**Owner:** parent agent (uses /nano-banana skill — already proven on pay-me-back)
**Files:** `public/banner.png`

Pixel-art wide horizontal banner. Composition per CONTEXT V-01. Warm sunset palette with teal accent.

**Done when:** PNG saved to `public/banner.png`, ~600KB-ish, looks like a sibling of pay-me-back's banner.

---

### T-02 — Per-poll OG preview images
**Files:** `src/pages/og/[slug].png.ts`, update `src/pages/[slug]/[token].astro` + `src/pages/[slug]/admin/[token].astro` to pass `ogImage` prop, ensure BaseLayout already supports it (it should — ported from pay-me-back in Phase 1)

**Steps:**
1. Port pay-me-back's `src/pages/og/[token].png.ts` shape but keyed on `slug` not `token`
2. Layout: top "WHEN WE GO" brand, middle title + destination + participant count, bottom days-remaining + "TAP TO VOTE →" button
3. Same Satori + Resvg + Inter-ExtraBold font setup; copy `public/fonts/Inter-ExtraBold.ttf` from pay-me-back if not already there
4. Pages pass `ogImage={'/og/' + slug + '.png'}` and a sensible `ogDescription`
5. Verify in built dist that PNGs render + meta tags reference absolute URLs (requires `PUBLIC_SITE_URL` env var at build)

**Done when:** `npm run build` produces `dist/og/copenhagen-2026.png`, page HTML contains `<meta property="og:image" content="...">` resolving to that file.

---

### T-03 — Polished README
**Files:** `README.md` (overwrite)

**Steps:**
1. Mirror pay-me-back's README structure (sections + ordering) per CONTEXT D-01
2. Banner at top, badges row, "Live demo" green button + direct links to Copenhagen demo URLs (after T-05 deploy succeeds — initially fill in placeholder links, update after deploy)
3. Five-use-cases section with concrete framing
4. Architecture diagram (port pay-me-back's; adapt for when-we-go's slug/token routing)
5. Pre-launch checklist + data retention adapted to votes-not-debts
6. Sibling project section linking to pay-me-back

**Done when:** README renders cleanly on GitHub web view (visible banner, working badges, all links resolve).

---

### T-04 — .env.example update
**Files:** `.env.example`

Add `WHENWEGO_DEMO_MODE` documentation (already exists from Phase 1 — verify still accurate). Document any other env vars added in Phase 2 (Telegram, ALLOWED_ORIGINS) if not already there.

**Done when:** every env var consumed by the build/Worker/scripts has an entry in `.env.example`.

---

### T-05 — Demo deployment
**Owner:** parent agent (needs wrangler CLI which is auth'd to info@leonardboeker.com)

**Steps:**
1. Build with demo env vars set:
   - `PUBLIC_SITE_URL=https://main.when-we-go-demo.pages.dev`
   - `WHENWEGO_DEMO_MODE=true`
   - `WHENWEGO_ADMIN_TOKEN=demo-admin-do-not-use-12345` (if prebuild needs it)
   - Polls JSON: the Copenhagen example with `pollCloseAt` in distant future (2099)
2. `npx wrangler pages deploy dist --project-name=when-we-go-demo --branch=main`
3. Verify: visit https://main.when-we-go-demo.pages.dev/copenhagen-2026/EXAMPLE_TOKEN_LEO_REPLACE/ → should render the participant page with demo banner at top
4. Update README links with the live demo URL

**Done when:** demo URL responds 200 with the demo banner visible.

---

### T-06 — Flip to public + mark as template
**Owner:** parent agent

```bash
gh repo edit Leonardboeker/when-we-go --visibility public --accept-visibility-change-consequences
gh repo edit Leonardboeker/when-we-go --template
gh repo edit Leonardboeker/when-we-go --add-topic astro --add-topic cloudflare-pages --add-topic cloudflare-workers --add-topic durable-objects --add-topic tailwindcss --add-topic date-coordination --add-topic trip-planning --add-topic template --add-topic typescript --add-topic pixel-art
```

**Done when:** repo visibility = public, template flag = true, topics visible.

---

### T-07 — Final smoke against deployed demo
**Files:** none (CLI only)

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://main.when-we-go-demo.pages.dev/
curl -s -o /dev/null -w "%{http_code}\n" https://main.when-we-go-demo.pages.dev/copenhagen-2026/EXAMPLE_TOKEN_LEO_REPLACE/
curl -s -o /dev/null -w "%{http_code}\n" https://main.when-we-go-demo.pages.dev/copenhagen-2026/admin/EXAMPLE_ORG_TOKEN_REPLACE/
curl -s -o /dev/null -w "%{http_code}\n" https://main.when-we-go-demo.pages.dev/og/copenhagen-2026.png
curl -s -o /dev/null -w "%{http_code}\n" https://main.when-we-go-demo.pages.dev/banner.png
```

All five should return 200.

---

### T-08 — STATE.md update + commit + push
Update STATE.md to reflect Phase 3 done. Commit everything. Push.

---

## Acceptance criteria for Phase 3 done

All of:
1. `public/banner.png` exists and is referenced in README
2. `dist/og/<slug>.png` generated for the example poll, OG meta tags resolve absolute URLs
3. README has all sections from CONTEXT D-01, renders cleanly on github.com
4. `https://main.when-we-go-demo.pages.dev/` returns 200 with the demo banner
5. `gh repo view Leonardboeker/when-we-go --json visibility,isTemplate` returns `{visibility: "PUBLIC", isTemplate: true}`
6. Topics added
7. STATE.md updated, commit pushed

## Order of execution

1. T-01 banner first (parent agent uses /nano-banana skill)
2. T-02 + T-03 + T-04 — subagent (lots of file work)
3. T-05 demo deploy — parent agent (wrangler CLI access)
4. T-06 visibility flip — parent agent (gh CLI)
5. T-07 smoke — parent agent
6. T-08 commit + push — parent agent

## What Phase 3 explicitly does NOT include

- ❌ Worker deploy for the demo (static-only demo is enough, calendar JS gracefully fails on POST since `/api/vote` doesn't exist)
- ❌ Multi-language i18n
- ❌ Production deployment for Leo's actual Copenhagen poll (Leo does this himself when ready)
- ❌ AI suggestions / booking integrations / pay-me-back hand-off (post-MVP futures)
