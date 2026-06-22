// worker/handlers/admin-send-vote-reminder.ts
// POST /api/admin/send-vote-reminder?slug=X
// Manually trigger the "please vote" reminder to every participant who hasn't
// voted yet — same mail the cron sends 3 days before pollCloseAt, but
// available NOW for organisers who want to nudge participants earlier.
// Auth via X-Organizer-Token header. Idempotency flag (poll_vote_reminder_sent)
// is bypassed by this admin path — re-sending is the explicit intent here.
import type { Env, WhenWeGoPollDO, ParticipantProfile } from '../durable-object';
import { errorResponse, jsonResponse } from '../lib/cors';
import { findPoll, validateOrganizerToken } from '../lib/polls-config';
import { sendEmail } from '../lib/notify-pipeline';

export async function handleAdminSendVoteReminder(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const orgToken = req.headers.get('X-Organizer-Token') ?? '';

  if (!slug) return errorResponse('Missing slug', 400, req, env);
  const poll = findPoll(env, slug);
  if (!poll || !orgToken || !validateOrganizerToken(poll, orgToken)) {
    return errorResponse('Not found', 404, req, env);
  }

  const stub = env.WHENWEGO_POLL_DO.get(
    env.WHENWEGO_POLL_DO.idFromName(slug)
  ) as unknown as DurableObjectStub<WhenWeGoPollDO>;

  if (await stub.isClosed()) {
    return errorResponse('Poll is already closed', 409, req, env);
  }

  const voterStatus = (await stub.getVoterStatus()) as Array<{
    token: string;
    vote_count: number;
  }>;
  const votedTokens = new Set(
    voterStatus.filter((v) => v.vote_count > 0).map((v) => v.token)
  );

  const allProfiles = (await stub.getAllProfiles()) as Array<
    { token: string } & ParticipantProfile
  >;
  const profilesByToken = new Map(allProfiles.map((p) => [p.token, p]));

  const siteUrl =
    (env.WHENWEGO_SITE_URL && env.WHENWEGO_SITE_URL.replace(/\/$/, '')) ||
    'https://when-we-go-demo.pages.dev';

  const destination = poll.destination ?? poll.title;
  const closeMs = Date.parse(poll.pollCloseAt);
  const daysLeft = Number.isFinite(closeMs)
    ? Math.max(1, Math.ceil((closeMs - Date.now()) / 86400000))
    : 0;
  const closesOn = poll.pollCloseAt.slice(0, 10);

  const targets: Array<{ name: string; email: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const participant of poll.participants) {
    if (votedTokens.has(participant.token)) {
      skipped.push({ name: participant.name, reason: 'already_voted' });
      continue;
    }
    const profile = profilesByToken.get(participant.token);
    if (!profile?.email) {
      skipped.push({ name: participant.name, reason: 'no_email' });
      continue;
    }
    targets.push({ name: participant.name, email: profile.email });

    const pageUrl = `${siteUrl}/${poll.slug}/${participant.token}/`;
    const subject =
      daysLeft <= 3
        ? `⏰ Nur noch ${daysLeft} ${daysLeft === 1 ? 'Tag' : 'Tage'}: Abstimmen für ${destination}`
        : `🗓️ Erinnerung: Termin für ${destination} abstimmen`;
    const text = [
      `Hey ${participant.name},`,
      '',
      daysLeft <= 3
        ? `Nur noch ${daysLeft} ${daysLeft === 1 ? 'Tag' : 'Tage'} bis die Abstimmung für "${poll.title}" schließt (${closesOn}).`
        : `Kurze Erinnerung: die Abstimmung für "${poll.title}" läuft noch bis ${closesOn} — wenn du noch nicht abgestimmt hast, ist jetzt ein guter Moment.`,
      '',
      `Hier dein persönlicher Link: ${pageUrl}`,
      '',
      '– Das when-we-go Team',
    ].join('\n');
    const html = `
      <p>Hey <strong>${participant.name}</strong>,</p>
      <p>${
        daysLeft <= 3
          ? `Nur noch <strong>${daysLeft} ${daysLeft === 1 ? 'Tag' : 'Tage'}</strong> bis die Abstimmung für <em>${poll.title}</em> schließt (${closesOn}).`
          : `Kurze Erinnerung: die Abstimmung für <em>${poll.title}</em> läuft noch bis <strong>${closesOn}</strong> — wenn du noch nicht abgestimmt hast, ist jetzt ein guter Moment.`
      }</p>
      <p><a href="${pageUrl}" style="display:inline-block;padding:12px 24px;background:#0066cc;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Jetzt abstimmen →</a></p>
      <p style="color:#888;font-size:12px;">Ziel: ${destination}</p>
    `.trim();

    ctx.waitUntil(
      sendEmail(env, { to: profile.email, subject, html, text })
        .then((res) => {
          console.log(
            `[admin][vote-reminder] ${poll.slug} → ${participant.name}: ok=${res.ok} skipped=${res.skipped}`
          );
        })
        .catch((err) => {
          console.error(
            `[admin][vote-reminder] send failed for ${participant.name}`,
            err
          );
        })
    );
  }

  // Mark the cron flag so it doesn't auto-fire again on the 3-days-before tick.
  await stub.setMeta('poll_vote_reminder_sent', String(Date.now()));

  return jsonResponse(
    { ok: true, sent: targets, skipped, daysLeft, closesOn },
    { status: 200 },
    req,
    env
  );
}
