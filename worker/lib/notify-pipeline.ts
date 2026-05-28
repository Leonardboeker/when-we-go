// worker/lib/notify-pipeline.ts
// Notifications for when-we-go. Phase 2 was Telegram-only; Phase 8 adds Resend
// fan-out for per-participant emails (close-summary, later reminders).
//
// All functions return { ok, skipped?, error? } — never throw. If the env vars
// are unset → skipped:true silently so adopters without those services still work.
import type { Env } from '../durable-object';
import type { Overlap } from './overlap';
import { sendTelegram } from './telegram';
import {
  sendResendEmail,
  type ResendAttachment,
  type SendResendEmailResult,
} from './resend';

export interface NotifyResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

function envReady(env: Env): boolean {
  return Boolean(env.WHENWEGO_TELEGRAM_BOT_TOKEN && env.WHENWEGO_TELEGRAM_CHAT_ID);
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function fmtDate(iso: string): string {
  // "2026-07-12" -> "Jul 12"
  const [, m, d] = iso.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  const dayNum = parseInt(d, 10);
  return `${MONTH_SHORT[monthIdx] ?? m} ${dayNum}`;
}

function fmtRange(start: string, end: string): string {
  if (start === end) return fmtDate(start);
  // Compact "Jul 12-15" if same month, else "Jul 28 - Aug 2".
  const [, sm] = start.split('-');
  const [, em] = end.split('-');
  if (sm === em) {
    const endDay = parseInt(end.split('-')[2], 10);
    return `${fmtDate(start)}-${endDay}`;
  }
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

export interface FirstVoteParams {
  pollSlug: string;
  voterName: string;
  votedSoFar: number;
  totalParticipants: number;
}

export async function notifyFirstVote(
  env: Env,
  params: FirstVoteParams
): Promise<NotifyResult> {
  if (!envReady(env)) return { ok: false, skipped: true };
  const text =
    `🗳️ ${params.voterName} voted on ${params.pollSlug} ` +
    `(${params.votedSoFar} of ${params.totalParticipants} voters now in)`;
  const res = await sendTelegram(
    env.WHENWEGO_TELEGRAM_BOT_TOKEN as string,
    env.WHENWEGO_TELEGRAM_CHAT_ID as string,
    text
  );
  if (res.ok) return { ok: true };
  console.error('[notify] firstVote send failed', res.error);
  return { ok: false, error: res.error };
}

export interface CloseParams {
  pollSlug: string;
  overlap: Overlap;
}

function buildCloseText(p: CloseParams): string {
  const ranges = p.overlap.ranges;
  const perfect = ranges.filter((r) => r.tier === 'perfect');
  const withEffort = ranges.filter((r) => r.tier === 'withEffort');

  if (perfect.length === 0 && withEffort.length === 0) {
    // "No overlap" branch (CONTEXT A-07 third row).
    const oneShort = ranges.filter((r) => r.tier === 'oneShort');
    if (oneShort.length > 0) {
      const top = oneShort[0];
      // Participant count: derive "N-of-M" from the perDate breakdown of that range's start day.
      const bd = p.overlap.perDate[top.start];
      const need = bd ? bd.yes + bd.maybe + bd.no + bd.unvoted : 0;
      return (
        `😕 ${p.pollSlug} closed. No dates work for everyone. ` +
        `Best is ${bd ? bd.yes : '?'}-of-${need} on ${fmtRange(top.start, top.end)}.`
      );
    }
    return `😕 ${p.pollSlug} closed. No dates work for everyone.`;
  }

  const parts: string[] = [`🎉 ${p.pollSlug} closed.`];
  if (perfect.length > 0) {
    const top = perfect[0];
    parts.push(`Perfect dates: ${fmtRange(top.start, top.end)} (${top.length} days).`);
  }
  if (withEffort.length > 0) {
    const top = withEffort[0];
    parts.push(`With effort: ${fmtRange(top.start, top.end)} (${top.length} days).`);
  }
  return parts.join(' ');
}

export async function notifyPollClose(
  env: Env,
  params: CloseParams
): Promise<NotifyResult> {
  if (!envReady(env)) return { ok: false, skipped: true };
  const text = buildCloseText(params);
  const res = await sendTelegram(
    env.WHENWEGO_TELEGRAM_BOT_TOKEN as string,
    env.WHENWEGO_TELEGRAM_CHAT_ID as string,
    text
  );
  if (res.ok) return { ok: true };
  console.error('[notify] pollClose send failed', res.error);
  return { ok: false, error: res.error };
}

// ─── Phase 8: Resend email fan-out ─────────────────────────────────────
// Thin wrapper around sendResendEmail that silently skips when
// WHENWEGO_RESEND_API_KEY is unset (mirrors the Telegram skip pattern).
// Callers fire-and-forget via ctx.waitUntil — we never block the API response
// on email delivery (close-summary fan-out can take seconds for N participants).

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: ResendAttachment[];
}

export interface SendEmailResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  error?: string;
}

export async function sendEmail(
  env: Env,
  params: SendEmailParams
): Promise<SendEmailResult> {
  if (!env.WHENWEGO_RESEND_API_KEY) {
    return { ok: false, skipped: true };
  }
  const res: SendResendEmailResult = await sendResendEmail({
    apiKey: env.WHENWEGO_RESEND_API_KEY,
    from: env.WHENWEGO_RESEND_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    attachments: params.attachments,
  });
  // Log every send result so smoke tests + organiser have a paper trail.
  // 422 from Resend is "can only send to verified addresses" — expected in
  // sandbox mode, still confirms the integration ran end-to-end.
  console.log(
    `[notify] email to=${params.to} subject="${params.subject}" status=${res.status ?? '?'} ok=${res.ok}${res.error ? ` error=${res.error}` : ''}`
  );
  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
  };
}
