# when-we-go

> Tiny date-coordination microsite for small groups planning a trip together.
> "Doodle for trips" — collect everyone's available dates, find overlaps, decide.

## One-line pitch

A small group of friends/family wants to go somewhere together. Each person gets a personal URL where they mark which dates they're free. The polling window closes after N days; the organiser sees the dates that work for everyone.

## Why now

Real-world driver: Leo + sister + father + brother want to go to **Copenhagen** together. Standard problem — four calendars, no shared system. Doodle works but feels clinical and asks for an account; Google Calendar's "find a time" only works for people in the same workspace; WhatsApp polls don't aggregate well.

This is the smallest possible solution that fits the actual use case, with room to grow into a fuller trip-planning tool later (see [Sibling project](#sibling-project)).

## Audience

- **Primary:** Leo + 3 family members, the Copenhagen trip.
- **Secondary (template adopters):** 3-8 person groups (family, close friends, small teams) who want to coordinate dates without anyone needing an account.

NOT for: enterprise scheduling, doctor's appointments, public events with 50+ respondents. Different problem shape.

## Constraints

| Constraint | Value |
|---|---|
| **Timeline** | Live before the next family conversation (~1-2 weeks). |
| **Hosting cost** | €0/month, Cloudflare free tier. |
| **Account model** | No accounts. Per-token URLs (mirror of pay-me-back). |
| **Data retention** | Auto-delete window data 30 days after poll closes. |
| **Privacy** | Each respondent sees only their own grid + (after close) the overlap. Not each other's individual answers. |

## Sibling project

This is the second tool in a tiny "friend-sized internet" series. Sibling: **[pay-me-back](https://github.com/Leonardboeker/pay-me-back)** — same group-of-friends shape, same tech stack, same aesthetic. The two interlock naturally:

- `when-we-go` figures out **when** the group is going.
- `pay-me-back` figures out **who pays what** for the trip.

Eventually a future phase could spawn a `pay-me-back` instance directly from a closed `when-we-go` poll ("trip is confirmed for July 12-15, you owe €240 for the Airbnb, here's your token") — but that's explicitly out of scope for the MVP.

## Tech stack (proposed — locked in during Phase 1 discuss)

Same shape as pay-me-back so the learnings transfer 1:1:

- **Astro 6** — static output, per-token routes via `getStaticPaths`
- **Tailwind v4** — Vite plugin, CSS-first config
- **Cloudflare Pages** — static hosting + git integration
- **Cloudflare Worker + Durable Object (SQLite)** — vote submission, overlap calculation, polling-window state
- **Telegram Bot** — optional organiser notifications

## Out of scope for MVP

- AI-assisted hotel/activity suggestions (Phase 3+ later)
- Booking integrations (Booking.com, Airbnb)
- Payment collection (delegate to pay-me-back when the time comes)
- Recurring polls / multi-trip coordination
- Mobile app
- Real-time updates (polling window auto-close is fine via Worker scheduled handler)

## Success looks like

- Leo creates one poll, sends 4 URLs via WhatsApp
- All 4 family members open their URL, click some dates, hit "save"
- 2 weeks later the poll auto-closes
- Leo gets a Telegram ping with the overlap dates
- Each family member can revisit their URL and see "decision: July 12-15"
- Total dev time: ≤ 3 weekends
- Total recurring cost: €0
