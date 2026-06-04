---
phase: 07-activity-suggestions
plan: 01
subsystem: "activities"
tags: ["worker", "provider-abstracted", "claude-api"]
provides: ["activity-suggestions"]
affects: ["participant-page", "close-email-fanout", "reminder-fanout", "cron"]
tech-stack:
  added: ["Anthropic Claude Haiku via tools API", "ActivityProvider abstraction"]
  patterns: ["ActivityProvider interface + getActivityProvider() factory", "7-day proposal_cache"]
key-files:
  created:
    - worker/lib/claude.ts
    - worker/lib/activity-provider.ts
    - worker/lib/activity-provider-claude.ts
    - worker/lib/activity-provider-mock.ts
    - worker/lib/activity-provider-mock.test.ts
    - worker/lib/activities.ts
    - worker/handlers/activities.ts
    - worker/handlers/activities-refresh.ts
    - src/components/ActivitiesList.astro
    - .planning/phases/07-activity-suggestions/07-PLAN.md
  modified:
    - worker/durable-object.ts
    - worker/index.ts
    - worker/scheduled.ts
    - worker/lib/close-email-fanout.ts
    - worker/lib/reminder-fanout.ts
    - src/pages/[slug]/[token].astro
    - wrangler.toml
    - scripts/smoke-test.mjs
key-decisions:
  - "Claude Haiku via tools API — structured output, no prose parsing"
  - "Two tiers: thisWeek (time-bound) + alwaysGreat (evergreen)"
  - "Confidence badges: medium/low items flagged in UI"
  - "7-day cache TTL — activities slower-moving than flight prices"
  - "MockActivityProvider fallback when WHENWEGO_ANTHROPIC_API_KEY unset"
patterns-established:
  - "claudeStructured() helper reusable for future LLM features"
duration: "1 day"
completed: 2026-05-29
---

# Phase 7: Activity Suggestions Summary

**Provider-abstracted activity suggestions via Claude Haiku structured-output (tools API). Two tiers: time-bound events + evergreen highlights. Confidence badges. Falls back to MockActivityProvider when API key unset.**

## Accomplishments

- GET /api/activities — shared list per poll, 7-day cache
- POST /api/activities/refresh — organiser force-refresh, 24h rate-limit
- ClaudeActivityProvider — tools API, forced JSON schema, two-tier output
- MockActivityProvider — hand-curated evergreens per top destination
- ActivitiesList.astro — confidence badges (medium/low), type icons
- Wired into close-summary email, T-7 reminder, cron pre-fetch on close
- smoke-test.mjs extended with activities assertions

## Next Phase Readiness

Activity list available in close-summary email (Phase 8) and T-7 reminder (Phase 9).
