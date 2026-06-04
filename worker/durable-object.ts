// worker/durable-object.ts
// WhenWeGoPollDO — one SQLite-backed Durable Object instance per poll, keyed by
// slug via env.WHENWEGO_POLL_DO.idFromName(slug). Schema (CONTEXT A-02):
//
//   votes          per-(token, date) row; absence = unset/no
//   vote_history   per-participant metadata for "did they vote yet" + counts
//   poll_meta      catch-all key/value for closed_at, close_notified_at,
//                  overlap_cache (JSON blob)
//
// All write methods wrap their SQL in single statements (DO serialises method
// calls so no explicit transactions needed for atomicity).
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  WHENWEGO_POLL_DO: DurableObjectNamespace;
  WHENWEGO_POLLS_JSON?: string;
  WHENWEGO_TELEGRAM_BOT_TOKEN?: string;
  WHENWEGO_TELEGRAM_CHAT_ID?: string;
  // Phase 8 — Resend email integration (close-summary + future reminders).
  // When unset, sendEmail() silently skips (Telegram-only mode still works).
  WHENWEGO_RESEND_API_KEY?: string;
  WHENWEGO_RESEND_FROM?: string;
  // Absolute base URL for links inside emails (must be absolute — relative
  // URLs don't work in email clients). Dev default: http://localhost:4321.
  WHENWEGO_SITE_URL?: string;
  // CORS allow-list (comma-separated). Defaults include localhost:4321/8787.
  ALLOWED_ORIGINS?: string;
  WHENWEGO_PHASE?: string;
  // Phase 5 — Amadeus Self-Service API (flight search).
  // Both client_id + client_secret optional secrets. When EITHER is missing,
  // flights handlers return reason: 'not_configured' instead of throwing.
  // ENV defaults to 'test' → https://test.api.amadeus.com (free tier).
  WHENWEGO_AMADEUS_CLIENT_ID?: string;
  WHENWEGO_AMADEUS_CLIENT_SECRET?: string;
  WHENWEGO_AMADEUS_ENV?: string;
  // Phase 7 — Anthropic Claude API key for activity suggestions.
  // When unset, getActivityProvider() returns the MockActivityProvider
  // (deterministic per-destination evergreen lookup). When set, the real
  // ClaudeActivityProvider drives structured-output calls to Haiku.
  WHENWEGO_ANTHROPIC_API_KEY?: string;
  // Phase 5 real provider — Kiwi.com Tequila (free tier, no CC needed).
  // Sign up: https://tequila.kiwi.com/portal/login
  // When unset, getFlightProvider() falls back to MockFlightProvider.
  WHENWEGO_KIWI_API_KEY?: string;
}

export type VoteState = 'yes' | 'maybe' | 'no';

export interface VoteInput {
  date: string;
  state: VoteState;
}

export interface VoteRecord {
  token: string;
  date: string;
  state: VoteState;
  updated_at: number;
}

export interface VoterStatusRow {
  token: string;
  first_voted_at: number;
  last_voted_at: number;
  vote_count: number;
}

// Phase 4 — participant_profile schema. Lives in the DO ONLY (never in polls.json
// or any other env-committed location) because emails are personal data.
// `interests` is stored as a JSON-array string so we can keep the row flat.
export type ProfileInterest =
  | 'museums'
  | 'outdoors'
  | 'food'
  | 'nightlife'
  | 'history'
  | 'festivals'
  | 'shopping'
  | 'beach';

export interface ParticipantProfile {
  email?: string;
  homeAirport?: string;   // IATA 3-letter code, uppercase
  homeCity?: string;
  budgetMaxEur?: number;
  interests?: ProfileInterest[];
}

// Row shape as stored in SQLite. `interests` arrives/leaves as JSON string.
interface ProfileRow {
  token: string;
  email: string | null;
  home_airport: string | null;
  home_city: string | null;
  budget_max_eur: number | null;
  interests: string | null;
  updated_at: number;
}

export class WhenWeGoPollDO extends DurableObject {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Idempotent schema setup — runs on every DO load. The IF NOT EXISTS guards
    // prevent re-creation; cheap if tables already exist.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        token       TEXT NOT NULL,
        date        TEXT NOT NULL,
        state       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (token, date)
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vote_history (
        token            TEXT PRIMARY KEY,
        first_voted_at   INTEGER NOT NULL,
        last_voted_at    INTEGER NOT NULL,
        vote_count       INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS poll_meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participant_profile (
        token            TEXT PRIMARY KEY,
        email            TEXT,
        home_airport     TEXT,
        home_city        TEXT,
        budget_max_eur   INTEGER,
        interests        TEXT,
        updated_at       INTEGER NOT NULL
      );
    `);
    // Phase 9 — reminder idempotency tracker. PRIMARY KEY (token, type) means
    // we can never double-send the same reminder type to the same participant.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reminders_sent (
        token        TEXT NOT NULL,
        type         TEXT NOT NULL,
        sent_at      INTEGER NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        PRIMARY KEY (token, type)
      );
    `);
    // Phase 9 (forward-compat) — generic key/value cache used for
    // expiring lookups (e.g. weather forecast 6h TTL). Phase 5 will reuse
    // for Amadeus proposal caching.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS proposal_cache (
        key          TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        expires_at   INTEGER NOT NULL
      );
    `);
    // Phase 10 — per-participant cost split (hotel share + flight + other).
    // One row per participant token; absence = "no override stored yet" and
    // the handler falls back to computed defaults.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cost_split (
        token            TEXT PRIMARY KEY,
        hotel_share_eur  INTEGER NOT NULL DEFAULT 0,
        flight_eur       INTEGER NOT NULL DEFAULT 0,
        other_eur        INTEGER NOT NULL DEFAULT 0,
        notes            TEXT
      );
    `);
  }

  // Bulk-replace votes for a token in one DO method call (CONTEXT A-04).
  // Atomic because DO serialises method invocations — no two castVotes calls
  // for the same DO can interleave.
  castVotes(
    token: string,
    votes: VoteInput[]
  ): { voteCount: number; wasFirstVote: boolean } {
    const now = Date.now();

    // 1. Wipe existing votes for this token.
    this.sql.exec(`DELETE FROM votes WHERE token = ?`, token);

    // 2. Insert one row per submitted vote.
    for (const v of votes) {
      this.sql.exec(
        `INSERT INTO votes (token, date, state, updated_at) VALUES (?, ?, ?, ?)`,
        token,
        v.date,
        v.state,
        now
      );
    }

    // 3. Upsert vote_history.
    const existing = this.sql
      .exec(`SELECT vote_count FROM vote_history WHERE token = ?`, token)
      .toArray() as Array<{ vote_count: number }>;
    const wasFirstVote = existing.length === 0;

    if (wasFirstVote) {
      this.sql.exec(
        `INSERT INTO vote_history (token, first_voted_at, last_voted_at, vote_count)
         VALUES (?, ?, ?, 1)`,
        token,
        now,
        now
      );
    } else {
      this.sql.exec(
        `UPDATE vote_history
         SET last_voted_at = ?, vote_count = vote_count + 1
         WHERE token = ?`,
        now,
        token
      );
    }

    return { voteCount: votes.length, wasFirstVote };
  }

  getVotesForToken(token: string): VoteRecord[] {
    return this.sql
      .exec(
        `SELECT token, date, state, updated_at FROM votes WHERE token = ? ORDER BY date ASC`,
        token
      )
      .toArray() as unknown as VoteRecord[];
  }

  getAllVotes(): VoteRecord[] {
    return this.sql
      .exec(`SELECT token, date, state, updated_at FROM votes ORDER BY date ASC, token ASC`)
      .toArray() as unknown as VoteRecord[];
  }

  getVoterStatus(): VoterStatusRow[] {
    return this.sql
      .exec(
        `SELECT token, first_voted_at, last_voted_at, vote_count FROM vote_history ORDER BY first_voted_at ASC`
      )
      .toArray() as unknown as VoterStatusRow[];
  }

  getMeta(key: string): string | null {
    const rows = this.sql
      .exec(`SELECT value FROM poll_meta WHERE key = ? LIMIT 1`, key)
      .toArray() as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO poll_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    );
  }

  // Mark the poll closed + persist the computed overlap. Caller supplies the
  // overlap JSON because computeOverlap depends on the Poll config which the
  // DO doesn't carry. Idempotent — calling closeNow twice on a closed poll
  // updates closed_at + overlap_cache to the newest values (caller should
  // gate on isClosed() to preserve original close time).
  closeNow(overlapJson: string): { closedAt: number } {
    const now = Date.now();
    this.setMeta('closed_at', String(now));
    this.setMeta('overlap_cache', overlapJson);
    return { closedAt: now };
  }

  isClosed(): boolean {
    return this.getMeta('closed_at') !== null;
  }

  // #8 — Reopen a closed poll. Clears all close-derived state so voting resumes,
  // and records a future close override (ISO ms) so the hourly cron won't
  // immediately re-close it (the configured pollCloseAt is in the past). Also
  // wipes reminders so the new cycle can re-fire. Idempotent.
  reopen(newCloseAtMs: number): { newCloseAt: number } {
    for (const key of ['closed_at', 'overlap_cache', 'trip_start', 'close_notified_at']) {
      this.sql.exec(`DELETE FROM poll_meta WHERE key = ?`, key);
    }
    this.sql.exec(`DELETE FROM reminders_sent`);
    this.setMeta('close_at_override', String(newCloseAtMs));
    return { newCloseAt: newCloseAtMs };
  }

  // #8 — Effective close timestamp: a reopen override wins over the configured
  // pollCloseAt. Returns null when no override is set (caller uses pollCloseAt).
  getCloseOverride(): number | null {
    const raw = this.getMeta('close_at_override');
    if (!raw) return null;
    const n = parseInt(raw as string, 10);
    return Number.isFinite(n) ? n : null;
  }

  // ─── Phase 4: participant profile ───────────────────────────────────
  // Upsert semantics — INSERT OR REPLACE so the caller doesn't need to know
  // whether a row already exists. `interests` is JSON-stringified for storage;
  // getProfile parses it back. Nullable columns map to undefined in TS land.
  setProfile(token: string, profile: ParticipantProfile): void {
    const now = Date.now();
    const interestsJson =
      profile.interests && profile.interests.length > 0
        ? JSON.stringify(profile.interests)
        : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO participant_profile
         (token, email, home_airport, home_city, budget_max_eur, interests, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      token,
      profile.email ?? null,
      profile.homeAirport ?? null,
      profile.homeCity ?? null,
      profile.budgetMaxEur ?? null,
      interestsJson,
      now
    );
  }

  getProfile(token: string): ParticipantProfile | null {
    const rows = this.sql
      .exec(
        `SELECT token, email, home_airport, home_city, budget_max_eur, interests, updated_at
         FROM participant_profile WHERE token = ? LIMIT 1`,
        token
      )
      .toArray() as unknown as ProfileRow[];
    if (rows.length === 0) return null;
    return rowToProfile(rows[0]);
  }

  // Admin view: all profiles, keyed by token. Used to compute the
  // `voterStatus[].profileComplete` flag in /api/admin/poll.
  getAllProfiles(): Array<{ token: string } & ParticipantProfile> {
    const rows = this.sql
      .exec(
        `SELECT token, email, home_airport, home_city, budget_max_eur, interests, updated_at
         FROM participant_profile`
      )
      .toArray() as unknown as ProfileRow[];
    return rows.map((r) => ({ token: r.token, ...rowToProfile(r) }));
  }

  // #5 (DSGVO) — full data export: every row of personal/poll data this DO
  // holds, so the organiser can fulfil an access/portability request.
  exportAll(): {
    exportedAt: number;
    votes: VoteRecord[];
    profiles: Array<{ token: string } & ParticipantProfile>;
    meta: Record<string, string>;
  } {
    const meta: Record<string, string> = {};
    for (const r of this.sql.exec(`SELECT key, value FROM poll_meta`).toArray() as Array<{
      key: string;
      value: string;
    }>) {
      meta[r.key] = r.value;
    }
    return {
      exportedAt: Date.now(),
      votes: this.getAllVotes(),
      profiles: this.getAllProfiles(),
      meta,
    };
  }

  // #5 (DSGVO) — irreversible deletion of every row this DO holds. Used for the
  // post-trip data wipe. Returns the per-table row counts removed.
  wipeAll(): Record<string, number> {
    const tables = [
      'votes',
      'vote_history',
      'poll_meta',
      'participant_profile',
      'reminders_sent',
      'proposal_cache',
      'cost_split',
    ];
    const removed: Record<string, number> = {};
    for (const t of tables) {
      const before = (
        this.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray() as Array<{ n: number }>
      )[0]?.n ?? 0;
      this.sql.exec(`DELETE FROM ${t}`);
      removed[t] = before;
    }
    return removed;
  }

  // ─── Phase 9: reminder send tracker ─────────────────────────────────
  // PRIMARY KEY (token, type) guarantees only one row per pair.
  // `wasReminderSent` returns true only when the existing row's status is
  // 'sent' — failed/skipped rows let us retry on the next cron tick.

  wasReminderSent(token: string, type: ReminderType): boolean {
    const rows = this.sql
      .exec(
        `SELECT status FROM reminders_sent WHERE token = ? AND type = ? LIMIT 1`,
        token,
        type
      )
      .toArray() as Array<{ status: string }>;
    if (rows.length === 0) return false;
    return rows[0].status === 'sent';
  }

  markReminderSent(
    token: string,
    type: ReminderType,
    status: ReminderStatus,
    error?: string
  ): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO reminders_sent (token, type, sent_at, status, error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token, type) DO UPDATE SET
         sent_at = excluded.sent_at,
         status  = excluded.status,
         error   = excluded.error`,
      token,
      type,
      now,
      status,
      error ?? null
    );
  }

  getReminderStatus(): ReminderStatusRow[] {
    return this.sql
      .exec(
        `SELECT token, type, sent_at, status, error
         FROM reminders_sent
         ORDER BY token ASC, type ASC`
      )
      .toArray() as unknown as ReminderStatusRow[];
  }

  clearReminder(token: string, type: ReminderType): void {
    this.sql.exec(
      `DELETE FROM reminders_sent WHERE token = ? AND type = ?`,
      token,
      type
    );
  }

  // ─── Phase 9: generic proposal_cache (also reusable by Phase 5) ──────
  // Stores time-bound JSON blobs. `getCached` returns null on miss + on
  // expired rows (and lazy-deletes the expired row).
  getCached(key: string): string | null {
    const rows = this.sql
      .exec(
        `SELECT value, expires_at FROM proposal_cache WHERE key = ? LIMIT 1`,
        key
      )
      .toArray() as Array<{ value: string; expires_at: number }>;
    if (rows.length === 0) return null;
    if (rows[0].expires_at <= Date.now()) {
      this.sql.exec(`DELETE FROM proposal_cache WHERE key = ?`, key);
      return null;
    }
    return rows[0].value;
  }

  setCached(key: string, value: string, ttlMs: number): void {
    const expiresAt = Date.now() + ttlMs;
    this.sql.exec(
      `INSERT INTO proposal_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      value,
      expiresAt
    );
  }

  // ─── Phase 10: cost_split (pay-me-back integration) ────────────────────
  // Upsert semantics — caller doesn't need to know if a row exists.
  // hotel/flight/other are integer EUR (rounded up at compute time).
  // Absence of a row = "no override stored"; handler falls back to defaults.
  getCostSplit(token: string): CostSplitRow | null {
    const rows = this.sql
      .exec(
        `SELECT token, hotel_share_eur, flight_eur, other_eur, notes
         FROM cost_split WHERE token = ? LIMIT 1`,
        token
      )
      .toArray() as unknown as CostSplitRow[];
    return rows[0] ?? null;
  }

  getAllCostSplits(): CostSplitRow[] {
    return this.sql
      .exec(
        `SELECT token, hotel_share_eur, flight_eur, other_eur, notes
         FROM cost_split ORDER BY token ASC`
      )
      .toArray() as unknown as CostSplitRow[];
  }

  setCostSplit(
    token: string,
    split: {
      hotelShareEur: number;
      flightEur: number;
      otherEur: number;
      notes?: string;
    }
  ): void {
    this.sql.exec(
      `INSERT INTO cost_split (token, hotel_share_eur, flight_eur, other_eur, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         hotel_share_eur = excluded.hotel_share_eur,
         flight_eur      = excluded.flight_eur,
         other_eur       = excluded.other_eur,
         notes           = excluded.notes`,
      token,
      Math.max(0, Math.round(split.hotelShareEur)),
      Math.max(0, Math.round(split.flightEur)),
      Math.max(0, Math.round(split.otherEur)),
      split.notes ?? null
    );
  }
}

// Phase 10 cost_split row shape (snake_case = SQLite column names).
export interface CostSplitRow {
  token: string;
  hotel_share_eur: number;
  flight_eur: number;
  other_eur: number;
  notes: string | null;
}

// Phase 9 reminder-type literal — kept as a union string so cron + admin
// callsites get type-safety even though SQLite stores it as plain TEXT.
export type ReminderType = 'T-30' | 'T-7' | 'T-1' | 'T+1';
export type ReminderStatus = 'sent' | 'failed' | 'skipped_no_email';

export interface ReminderStatusRow {
  token: string;
  type: ReminderType;
  sent_at: number;
  status: ReminderStatus;
  error: string | null;
}

function rowToProfile(r: ProfileRow): ParticipantProfile {
  let interests: ProfileInterest[] | undefined;
  if (r.interests) {
    try {
      const parsed = JSON.parse(r.interests);
      if (Array.isArray(parsed)) interests = parsed as ProfileInterest[];
    } catch {
      interests = undefined;
    }
  }
  return {
    email: r.email ?? undefined,
    homeAirport: r.home_airport ?? undefined,
    homeCity: r.home_city ?? undefined,
    budgetMaxEur: r.budget_max_eur ?? undefined,
    interests,
  };
}

// Profile is "complete" when both email + homeAirport are set (the two fields
// needed by Phases 5/8 for flights + notifications). Budget/interests are
// optional polish. Exported so /api/admin/poll can compute the boolean.
export function isProfileComplete(
  profile: ParticipantProfile | null
): boolean {
  if (!profile) return false;
  return Boolean(profile.email && profile.homeAirport);
}
