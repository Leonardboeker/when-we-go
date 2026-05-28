// worker/lib/schemas.ts
// Zod schemas for inbound API request validation.
// Response shapes live as TS interfaces in each handler — we don't validate
// outgoing JSON, it's cheaper to keep handlers as the single source of truth.
import { z } from 'zod';

export const VoteStateSchema = z.enum(['yes', 'maybe', 'no']);
export type VoteState = z.infer<typeof VoteStateSchema>;

export const VoteEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  state: VoteStateSchema,
});
export type VoteEntry = z.infer<typeof VoteEntrySchema>;

// Bulk-replace vote semantics (CONTEXT A-04): client posts ALL their current
// votes in one shot, server wipes prior rows + inserts these. 400 cap = ~1 year
// of daily votes — anything more is abuse / fat-finger.
export const VoteRequestSchema = z.object({
  slug: z.string().min(1).max(120),
  token: z.string().min(8).max(64),
  votes: z.array(VoteEntrySchema).max(400),
});
export type VoteRequest = z.infer<typeof VoteRequestSchema>;

// ─── Phase 4: participant profile ─────────────────────────────────────
// Validation lives in the worker so a malformed POST never reaches the DO.
// Email: standard Zod (no MX check — out of scope). IATA: exact 3 uppercase
// letters — preempts homoglyph attacks + matches the airports.json lookup key.
export const ProfileInterestSchema = z.enum([
  'museums',
  'outdoors',
  'food',
  'nightlife',
  'history',
  'festivals',
  'shopping',
  'beach',
]);
export type ProfileInterest = z.infer<typeof ProfileInterestSchema>;

export const ProfileSchema = z.object({
  email: z.string().email().max(254).optional(),
  homeAirport: z
    .string()
    .regex(/^[A-Z]{3}$/, 'homeAirport must be exactly 3 uppercase letters')
    .optional(),
  homeCity: z.string().max(100).optional(),
  budgetMaxEur: z.number().int().positive().max(100000).optional(),
  interests: z.array(ProfileInterestSchema).max(8).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileRequestSchema = z.object({
  slug: z.string().min(1).max(120),
  token: z.string().min(8).max(64),
  profile: ProfileSchema,
});
export type ProfileRequest = z.infer<typeof ProfileRequestSchema>;
