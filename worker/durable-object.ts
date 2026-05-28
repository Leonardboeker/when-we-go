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
  // CORS allow-list (comma-separated). Defaults include localhost:4321/8787.
  ALLOWED_ORIGINS?: string;
  WHENWEGO_PHASE?: string;
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
}
