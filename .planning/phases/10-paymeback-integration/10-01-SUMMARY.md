---
phase: 10-paymeback-integration
plan: 01
subsystem: "cost-split"
tags: ["worker", "admin", "pay-me-back"]
provides: ["cost-split-export"]
affects: ["admin-page", "durable-object"]
tech-stack:
  added: ["cost-defaults.ts (per-participant split calculation)"]
  patterns: ["cost_split DO table", "pay-me-back JSON export shape"]
key-files:
  created:
    - worker/handlers/admin-cost-split.ts
    - worker/handlers/admin-export-paymeback.ts
    - worker/lib/cost-defaults.ts
    - src/components/CostSplitPanel.astro
  modified:
    - worker/durable-object.ts
    - worker/index.ts
    - src/pages/[slug]/admin/[token].astro
key-decisions:
  - "Export copies JSON to clipboard + opens pay-me-back quick-start in new tab"
  - "Defaults: hotel cost/N + flight cost per participant (editable before export)"
  - "Freshly generated nanoid tokens for pay-me-back (don't reuse when-we-go tokens)"
  - "EUR-only — flight costs stored in EUR from Phase 5"
patterns-established:
  - "cost_split stored in DO so organiser edits persist across reloads"
duration: "2 days"
completed: 2026-05-29
---

# Phase 10: pay-me-back Integration Summary

**Organiser admin dashboard gains cost-split section: per-participant editable amounts defaulting to hotel/N + flight cost. "Export to pay-me-back" generates JSON for sister project.**

## Accomplishments

- GET /api/admin/cost-split — per-participant split with defaults
- POST /api/admin/cost-split — bulk update stored splits
- GET /api/admin/export-paymeback — pay-me-back shaped JSON
- CostSplitPanel.astro — editable amounts, one-click export + copy
- cost_split DO table for persistence

## Next Phase Readiness

All 10 planned phases complete. MVP → full trip planner with personalised proposals, emails, reminders, and cost export.
