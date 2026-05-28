// worker/durable-object.ts
// Phase 1 stub. One DO instance per poll, keyed by poll slug.
// Phase 2 fills in the SQLite schema for vote storage:
//   - votes (slug, token, date_iso, choice)        composite PK
//   - poll_state (slug, closed_at, close_notified) keyed by slug
//   - notifications (id, payload, attempted_count, last_error)
// plus the methods that read/write them.
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  WHENWEGO_DO: DurableObjectNamespace;
  // Optional Telegram (Phase 2 onwards)
  WHENWEGO_TELEGRAM_BOT_TOKEN?: string;
  WHENWEGO_TELEGRAM_CHAT_ID?: string;
  // Build-time materialised polls payload (JSON-stringified array)
  WHENWEGO_POLLS_JSON?: string;
}

export class WhenWeGoPollDO extends DurableObject {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Phase 2 will add CREATE TABLE IF NOT EXISTS statements here.
  }

  /** Phase 2 — record a participant's vote for a given date. */
  async castVote(
    _token: string,
    _dateIso: string,
    _choice: 'yes' | 'maybe' | 'no'
  ): Promise<{ ok: true; phase: 1 }> {
    return { ok: true, phase: 1 };
  }

  /** Phase 2 — return all votes for a poll (organiser-only). */
  async getAllVotes(): Promise<{ phase: 1; rows: [] }> {
    return { phase: 1, rows: [] };
  }

  /** Phase 2 — mark a poll closed and trigger a notification. */
  async closePoll(): Promise<{ ok: true; phase: 1 }> {
    return { ok: true, phase: 1 };
  }
}
