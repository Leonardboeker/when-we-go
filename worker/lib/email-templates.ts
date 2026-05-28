// worker/lib/email-templates.ts
// Render the per-participant close-summary email. Returns `{subject, html, text,
// attachments}` ready for sendResendEmail.
//
// Design rules (CONTEXT D-02):
//   - Table-based HTML layout (email clients still need this)
//   - Single column, max-width 600px
//   - Mobile-responsive via @media — `.stack-on-mobile` rule
//   - Plain-text fallback ALWAYS included
//   - Conditional sections: flights/hotels/activities omitted if empty (so the
//     template works in Phase 8 isolation before Phases 5-7 land)
//
// The .ics attachment is embedded as base64. Calendar apps recognise the
// `text/calendar` MIME type and offer to import on click.

import type { Poll, Participant } from './polls-config';
import type { ParticipantProfile } from '../durable-object';
import type { Overlap, OverlapRange } from './overlap';
import type { ResendAttachment } from './resend';
import type { AddToCalendarLinks } from './calendar-links';

// Forward-compatible shapes — Phases 5/6/7 will populate these.
export interface FlightOption {
  from: string;
  to: string;
  carrier?: string;
  priceEur?: number;
  url?: string;
}
export interface HotelOption {
  name: string;
  pricePerNightEur?: number;
  url?: string;
  area?: string;
}
export interface ActivityOption {
  name: string;
  url?: string;
  note?: string;
}
export interface ActivitiesBucket {
  thisWeek?: ActivityOption[];
  alwaysGreat?: ActivityOption[];
}

export interface CloseSummaryParams {
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile | null;
  overlap: Overlap;
  /** Personalised flight shortlist; empty in Phase 8 isolation. */
  flights?: FlightOption[];
  /** Shared hotels shortlist; empty in Phase 8 isolation. */
  hotels?: HotelOption[];
  activities?: ActivitiesBucket;
  /** Absolute URL to per-token page (`${siteUrl}/${slug}/${token}/`). */
  participantPageUrl: string;
  /** Absolute URL to authenticated .ics (`${siteUrl}/api/ical?slug=X&token=Y`). */
  icalUrl: string;
  /** Add-to-calendar deep-links — see worker/lib/calendar-links.ts. */
  addToCalendarLinks: AddToCalendarLinks;
  /** Absolute base URL — for embedded banner image. */
  siteUrl: string;
  /** Pre-built .ics content; will be base64-attached. */
  icsContent: string;
  /** Organiser display name from polls.json for footer attribution. */
  organiserName?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: ResendAttachment[];
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function fmtRangeShort(start: string, end: string): string {
  // "Jul 12-15" if same month, "Jul 28 - Aug 2" otherwise.
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const sMonth = MONTH_SHORT[ms - 1] ?? String(ms);
  const eMonth = MONTH_SHORT[me - 1] ?? String(me);
  if (ys === ye && ms === me) {
    if (ds === de) return `${sMonth} ${ds}`;
    return `${sMonth} ${ds}-${de}`;
  }
  return `${sMonth} ${ds} - ${eMonth} ${de}`;
}

function fmtRangeLong(start: string, end: string): string {
  return `${start} → ${end}`;
}

/** Pick the "best" trip range to feature in the email subject + greeting. */
function pickFeaturedRange(overlap: Overlap): OverlapRange | null {
  // overlap.ranges is already sorted by tier-weight DESC, length DESC, start ASC.
  return overlap.ranges[0] ?? null;
}

/** Encode a UTF-8 string as base64 — works in Workers + Node alike. */
function b64encode(s: string): string {
  // Workers runtime exposes `btoa` but it only handles latin1.
  // Use TextEncoder + array iteration to support unicode safely.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(s, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

/** Minimal HTML-escape for embedded strings. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSubject(params: CloseSummaryParams): string {
  const dest = params.poll.destination ?? params.poll.title;
  const featured = pickFeaturedRange(params.overlap);
  if (featured) {
    return `🎉 ${dest} is set — ${fmtRangeShort(featured.start, featured.end)}`;
  }
  // Fallback when no overlap found — use poll's full date range.
  return `📅 ${dest} — date check-in`;
}

function buildHtml(params: CloseSummaryParams): string {
  const dest = params.poll.destination ?? params.poll.title;
  const featured = pickFeaturedRange(params.overlap);
  const rangeShort = featured
    ? fmtRangeShort(featured.start, featured.end)
    : 'dates to be confirmed';
  const rangeLong = featured ? fmtRangeLong(featured.start, featured.end) : '';

  const flights = params.flights ?? [];
  const hotels = params.hotels ?? [];
  const activities = params.activities ?? {};
  const hasActivities =
    (activities.thisWeek?.length ?? 0) + (activities.alwaysGreat?.length ?? 0) > 0;

  const links = params.addToCalendarLinks;

  const sections: string[] = [];

  // Header banner
  sections.push(`
    <tr>
      <td align="center" style="padding:0;">
        <img src="${esc(params.siteUrl)}/banner.png" alt="when-we-go"
          width="600" height="auto"
          style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;" />
      </td>
    </tr>
  `);

  // Greeting + dates
  sections.push(`
    <tr>
      <td style="padding:24px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.2;font-weight:800;">
          Hey ${esc(params.participant.name)} — ${esc(dest)} is set.
        </h1>
        <p style="margin:0;font-size:32px;line-height:1.1;font-weight:900;color:#6750a4;">
          ${esc(rangeShort)}
        </p>
        ${rangeLong ? `<p style="margin:6px 0 0 0;font-size:13px;color:#666;">${esc(rangeLong)}</p>` : ''}
      </td>
    </tr>
  `);

  // Add-to-calendar buttons
  sections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;">
        <p style="margin:0 0 12px 0;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#666;">
          Add to your calendar
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td class="stack-on-mobile" style="padding:0 4px 8px 0;width:25%;">
              <a href="${esc(links.google)}" target="_blank" rel="noopener"
                style="display:block;text-align:center;padding:12px 8px;background:#4285f4;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;border-radius:6px;">
                Google
              </a>
            </td>
            <td class="stack-on-mobile" style="padding:0 4px 8px 4px;width:25%;">
              <a href="${esc(links.apple)}" target="_blank" rel="noopener"
                style="display:block;text-align:center;padding:12px 8px;background:#555555;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;border-radius:6px;">
                Apple
              </a>
            </td>
            <td class="stack-on-mobile" style="padding:0 4px 8px 4px;width:25%;">
              <a href="${esc(links.outlook)}" target="_blank" rel="noopener"
                style="display:block;text-align:center;padding:12px 8px;background:#0078d4;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;border-radius:6px;">
                Outlook
              </a>
            </td>
            <td class="stack-on-mobile" style="padding:0 0 8px 4px;width:25%;">
              <a href="${esc(links.yahoo)}" target="_blank" rel="noopener"
                style="display:block;text-align:center;padding:12px 8px;background:#6001d2;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;border-radius:6px;">
                Yahoo
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:8px 0 0 0;font-size:12px;color:#888;">
          The .ics attachment also imports natively into most calendars — open it from this email.
        </p>
      </td>
    </tr>
  `);

  // Flights section (conditional)
  if (flights.length > 0) {
    const rows = flights
      .map(
        (f) => `
          <tr>
            <td style="padding:8px 0;border-top:1px solid #eee;font-size:14px;">
              <strong>${esc(f.from)}</strong> → <strong>${esc(f.to)}</strong>
              ${f.carrier ? ` · ${esc(f.carrier)}` : ''}
              ${f.priceEur ? ` · €${f.priceEur}` : ''}
              ${f.url ? ` · <a href="${esc(f.url)}" style="color:#6750a4;">book</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    sections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            ✈️ Flights for you
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows}
          </table>
        </td>
      </tr>
    `);
  }

  // Hotels section (conditional)
  if (hotels.length > 0) {
    const rows = hotels
      .map(
        (h) => `
          <tr>
            <td style="padding:8px 0;border-top:1px solid #eee;font-size:14px;">
              <strong>${esc(h.name)}</strong>
              ${h.area ? ` · ${esc(h.area)}` : ''}
              ${h.pricePerNightEur ? ` · €${h.pricePerNightEur}/night` : ''}
              ${h.url ? ` · <a href="${esc(h.url)}" style="color:#6750a4;">view</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    sections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🏨 Hotels we shortlisted
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows}
          </table>
        </td>
      </tr>
    `);
  }

  // Activities section (conditional)
  if (hasActivities) {
    const renderList = (label: string, list: ActivityOption[]) =>
      list.length === 0
        ? ''
        : `
          <p style="margin:8px 0 4px 0;font-size:13px;font-weight:700;color:#666;text-transform:uppercase;">${esc(label)}</p>
          <ul style="margin:0 0 8px 18px;padding:0;font-size:14px;line-height:1.5;">
            ${list
              .map(
                (a) =>
                  `<li>${esc(a.name)}${
                    a.url ? ` · <a href="${esc(a.url)}" style="color:#6750a4;">info</a>` : ''
                  }${a.note ? ` <span style="color:#888;">— ${esc(a.note)}</span>` : ''}</li>`
              )
              .join('')}
          </ul>
        `;
    sections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🎭 Things to do
          </h2>
          ${renderList('This week', activities.thisWeek ?? [])}
          ${renderList('Always great', activities.alwaysGreat ?? [])}
        </td>
      </tr>
    `);
  }

  // Reminder preview block
  sections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <div style="border:2px solid #6750a4;background:#f3edf7;padding:16px;border-radius:8px;">
          <p style="margin:0 0 8px 0;font-size:14px;font-weight:800;color:#6750a4;">
            🔔 Reminders we'll send
          </p>
          <ul style="margin:0 0 0 18px;padding:0;font-size:13px;line-height:1.7;color:#444;">
            <li>30 days before — flight price refresh</li>
            <li>1 week before — packing checklist</li>
            <li>1 day before — final details</li>
            <li>1 day after — wrap-up</li>
          </ul>
          <p style="margin:8px 0 0 0;font-size:12px;color:#666;">
            Calendar alerts are also baked into the .ics attached to this email.
          </p>
        </div>
      </td>
    </tr>
  `);

  // Footer
  const orgAttribution = params.organiserName
    ? `${esc(params.organiserName)} set up this poll for ${esc(dest)}.`
    : `Someone set up a when-we-go poll for ${esc(dest)}.`;
  sections.push(`
    <tr>
      <td style="padding:24px 24px 32px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#666;font-size:12px;line-height:1.5;">
        <hr style="border:0;border-top:1px solid #ddd;margin:0 0 16px 0;" />
        <p style="margin:0 0 8px 0;">
          <a href="${esc(params.participantPageUrl)}" style="color:#6750a4;font-weight:700;">View your trip page →</a>
        </p>
        <p style="margin:0;">
          You're getting this because ${orgAttribution}
        </p>
      </td>
    </tr>
  `);

  // Wrap everything in the outer email shell.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(buildSubject(params))}</title>
  <style>
    @media (max-width: 600px) {
      .stack-on-mobile {
        display: block !important;
        width: 100% !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
          style="max-width:600px;background:#ffffff;border:3px solid #1c1b1f;box-shadow:4px 4px 0 #6750a4;">
          ${sections.join('\n')}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Plain-text fallback. Hand-built (not auto-stripped from HTML) for a cleaner
 * read. Some clients show ONLY this — don't reference visual styling here.
 */
function buildText(params: CloseSummaryParams): string {
  const dest = params.poll.destination ?? params.poll.title;
  const featured = pickFeaturedRange(params.overlap);
  const rangeShort = featured
    ? fmtRangeShort(featured.start, featured.end)
    : 'dates to be confirmed';
  const rangeLong = featured ? fmtRangeLong(featured.start, featured.end) : '';

  const flights = params.flights ?? [];
  const hotels = params.hotels ?? [];
  const activities = params.activities ?? {};
  const links = params.addToCalendarLinks;

  const out: string[] = [];
  out.push(`Hey ${params.participant.name} — ${dest} is set.`);
  out.push('');
  out.push(`Dates: ${rangeShort}${rangeLong ? ` (${rangeLong})` : ''}`);
  out.push('');
  out.push('Add to your calendar:');
  out.push(`  Google:  ${links.google}`);
  out.push(`  Apple:   ${links.apple}`);
  out.push(`  Outlook: ${links.outlook}`);
  out.push(`  Yahoo:   ${links.yahoo}`);
  out.push('');

  if (flights.length > 0) {
    out.push('Flights for you:');
    for (const f of flights) {
      const bits = [`  ${f.from} → ${f.to}`];
      if (f.carrier) bits.push(f.carrier);
      if (f.priceEur) bits.push(`€${f.priceEur}`);
      if (f.url) bits.push(`[${f.url}]`);
      out.push(bits.join(' · '));
    }
    out.push('');
  }

  if (hotels.length > 0) {
    out.push('Hotels we shortlisted:');
    for (const h of hotels) {
      const bits = [`  ${h.name}`];
      if (h.area) bits.push(h.area);
      if (h.pricePerNightEur) bits.push(`€${h.pricePerNightEur}/night`);
      if (h.url) bits.push(`[${h.url}]`);
      out.push(bits.join(' · '));
    }
    out.push('');
  }

  const allActs = [
    ...(activities.thisWeek ?? []),
    ...(activities.alwaysGreat ?? []),
  ];
  if (allActs.length > 0) {
    out.push('Things to do:');
    for (const a of allActs) {
      out.push(`  - ${a.name}${a.url ? ` [${a.url}]` : ''}${a.note ? ` — ${a.note}` : ''}`);
    }
    out.push('');
  }

  out.push('Reminders we will send:');
  out.push('  - 30 days before — flight price refresh');
  out.push('  - 1 week before — packing checklist');
  out.push('  - 1 day before — final details');
  out.push('  - 1 day after — wrap-up');
  out.push('');
  out.push(`View your trip page: ${params.participantPageUrl}`);
  out.push('');
  const orgAttribution = params.organiserName
    ? `${params.organiserName} set up this poll for ${dest}.`
    : `Someone set up a when-we-go poll for ${dest}.`;
  out.push(`You're getting this because ${orgAttribution}`);

  return out.join('\n');
}

export function renderCloseSummaryEmail(
  params: CloseSummaryParams
): RenderedEmail {
  const subject = buildSubject(params);
  const html = buildHtml(params);
  const text = buildText(params);
  const attachments: ResendAttachment[] = [
    {
      filename: `${params.poll.slug}.ics`,
      content_base64: b64encode(params.icsContent),
      content_type: 'text/calendar; charset=utf-8',
    },
  ];
  return { subject, html, text, attachments };
}
