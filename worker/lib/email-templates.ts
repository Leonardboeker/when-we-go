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
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];

const MONTH_LONG = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function fmtRangeShort(start: string, end: string): string {
  // "9.–12. Juli" if same month, "28. Jul – 2. Aug" otherwise.
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const sMonthShort = MONTH_SHORT[ms - 1] ?? String(ms);
  const eMonthShort = MONTH_SHORT[me - 1] ?? String(me);
  const sMonthLong = MONTH_LONG[ms - 1] ?? String(ms);
  if (ys === ye && ms === me) {
    if (ds === de) return `${ds}. ${sMonthLong}`;
    return `${ds}.–${de}. ${sMonthLong}`;
  }
  return `${ds}. ${sMonthShort} – ${de}. ${eMonthShort}`;
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
    return `🎉 ${dest} steht fest — ${fmtRangeShort(featured.start, featured.end)}`;
  }
  // Fallback when no overlap found — use poll's full date range.
  return `📅 ${dest} — Termin noch offen`;
}

function buildHtml(params: CloseSummaryParams): string {
  const dest = params.poll.destination ?? params.poll.title;
  const featured = pickFeaturedRange(params.overlap);
  const rangeShort = featured
    ? fmtRangeShort(featured.start, featured.end)
    : 'Termin noch offen';
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
          Hey ${esc(params.participant.name)} — ${esc(dest)} steht fest.
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
          Zum Kalender hinzufügen
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
          Der .ics-Anhang lässt sich auch direkt in die meisten Kalender importieren — öffne ihn einfach aus dieser Mail.
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
              ${f.url ? ` · <a href="${esc(f.url)}" style="color:#6750a4;">buchen</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    sections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            ✈️ Flüge für dich
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
              ${h.pricePerNightEur ? ` · €${h.pricePerNightEur}/Nacht` : ''}
              ${h.url ? ` · <a href="${esc(h.url)}" style="color:#6750a4;">ansehen</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    sections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🏨 Hotels in der Auswahl
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
            🎭 Aktivitäten
          </h2>
          ${renderList('Diese Woche', activities.thisWeek ?? [])}
          ${renderList('Immer gut', activities.alwaysGreat ?? [])}
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
            🔔 Erinnerungen, die wir dir schicken
          </p>
          <ul style="margin:0 0 0 18px;padding:0;font-size:13px;line-height:1.7;color:#444;">
            <li>30 Tage vorher — aktualisierte Flugpreise</li>
            <li>1 Woche vorher — Packliste</li>
            <li>1 Tag vorher — letzte Details</li>
            <li>1 Tag danach — Nachbereitung</li>
          </ul>
          <p style="margin:8px 0 0 0;font-size:12px;color:#666;">
            Kalender-Erinnerungen stecken auch im .ics-Anhang dieser Mail.
          </p>
        </div>
      </td>
    </tr>
  `);

  // Footer
  const orgAttribution = params.organiserName
    ? `${esc(params.organiserName)} diese Abstimmung für ${esc(dest)} erstellt hat`
    : `jemand eine when-we-go-Abstimmung für ${esc(dest)} erstellt hat`;
  sections.push(`
    <tr>
      <td style="padding:24px 24px 32px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#666;font-size:12px;line-height:1.5;">
        <hr style="border:0;border-top:1px solid #ddd;margin:0 0 16px 0;" />
        <p style="margin:0 0 8px 0;">
          <a href="${esc(params.participantPageUrl)}" style="color:#6750a4;font-weight:700;">Zur Reise-Seite →</a>
        </p>
        <p style="margin:0;">
          Du bekommst diese Mail, weil ${orgAttribution}.
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
    : 'Termin noch offen';
  const rangeLong = featured ? fmtRangeLong(featured.start, featured.end) : '';

  const flights = params.flights ?? [];
  const hotels = params.hotels ?? [];
  const activities = params.activities ?? {};
  const links = params.addToCalendarLinks;

  const out: string[] = [];
  out.push(`Hey ${params.participant.name} — ${dest} steht fest.`);
  out.push('');
  out.push(`Termin: ${rangeShort}${rangeLong ? ` (${rangeLong})` : ''}`);
  out.push('');
  out.push('Zum Kalender hinzufügen:');
  out.push(`  Google:  ${links.google}`);
  out.push(`  Apple:   ${links.apple}`);
  out.push(`  Outlook: ${links.outlook}`);
  out.push(`  Yahoo:   ${links.yahoo}`);
  out.push('');

  if (flights.length > 0) {
    out.push('Flüge für dich:');
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
    out.push('Hotels in der Auswahl:');
    for (const h of hotels) {
      const bits = [`  ${h.name}`];
      if (h.area) bits.push(h.area);
      if (h.pricePerNightEur) bits.push(`€${h.pricePerNightEur}/Nacht`);
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
    out.push('Aktivitäten:');
    for (const a of allActs) {
      out.push(`  - ${a.name}${a.url ? ` [${a.url}]` : ''}${a.note ? ` — ${a.note}` : ''}`);
    }
    out.push('');
  }

  out.push('Erinnerungen, die wir dir schicken:');
  out.push('  - 30 Tage vorher — aktualisierte Flugpreise');
  out.push('  - 1 Woche vorher — Packliste');
  out.push('  - 1 Tag vorher — letzte Details');
  out.push('  - 1 Tag danach — Nachbereitung');
  out.push('');
  out.push(`Zur Reise-Seite: ${params.participantPageUrl}`);
  out.push('');
  const orgAttribution = params.organiserName
    ? `${params.organiserName} diese Abstimmung für ${dest} erstellt hat`
    : `jemand eine when-we-go-Abstimmung für ${dest} erstellt hat`;
  out.push(`Du bekommst diese Mail, weil ${orgAttribution}.`);

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

// ─── Phase 9 — reminder emails (T-30 / T-7 / T-1 / T+1) ─────────────────
// Each render function takes a minimal params bag, returns {subject, html,
// text}. Unlike the close-summary, reminders do NOT include the .ics
// attachment (re-attaching the same calendar file every cron tick would
// confuse some clients into creating duplicate events). The participant
// already has the .ics from Phase 8's close-summary.
//
// Shared design: wrap each body in the same outer shell (banner + footer)
// as the close-summary so emails feel like one product, not four.

import type { Forecast } from './weather';
import { weatherCodeLabel } from './weather';

interface ReminderShellParams {
  poll: Poll;
  participant: Participant;
  siteUrl: string;
  participantPageUrl: string;
  organiserName?: string;
  // Greeting + headline shown at top of email
  headline: string;
  subheadline?: string;
  // Section blocks rendered inside the shell, in order
  bodyHtmlSections: string[];
  bodyTextSections: string[];
}

/** Build the outer banner + footer for reminder emails. */
function buildReminderHtmlShell(
  p: ReminderShellParams,
  subject: string
): string {
  const dest = p.poll.destination ?? p.poll.title;
  const orgAttribution = p.organiserName
    ? `${esc(p.organiserName)} diese Abstimmung für ${esc(dest)} erstellt hat`
    : `jemand eine when-we-go-Abstimmung für ${esc(dest)} erstellt hat`;

  const headerHtml = `
    <tr>
      <td align="center" style="padding:0;">
        <img src="${esc(p.siteUrl)}/banner.png" alt="when-we-go"
          width="600" height="auto"
          style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;" />
      </td>
    </tr>
    <tr>
      <td style="padding:24px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.2;font-weight:800;">
          ${esc(p.headline)}
        </h1>
        ${
          p.subheadline
            ? `<p style="margin:0;font-size:16px;line-height:1.4;color:#666;">${esc(p.subheadline)}</p>`
            : ''
        }
      </td>
    </tr>
  `;

  const footerHtml = `
    <tr>
      <td style="padding:24px 24px 32px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#666;font-size:12px;line-height:1.5;">
        <hr style="border:0;border-top:1px solid #ddd;margin:0 0 16px 0;" />
        <p style="margin:0 0 8px 0;">
          <a href="${esc(p.participantPageUrl)}" style="color:#6750a4;font-weight:700;">Zur Reise-Seite →</a>
        </p>
        <p style="margin:0;">
          Du bekommst diese Mail, weil ${orgAttribution}.
        </p>
      </td>
    </tr>
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(subject)}</title>
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
          ${headerHtml}
          ${p.bodyHtmlSections.join('\n')}
          ${footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildReminderTextShell(p: ReminderShellParams): string {
  const dest = p.poll.destination ?? p.poll.title;
  const out: string[] = [];
  out.push(p.headline);
  if (p.subheadline) out.push(p.subheadline);
  out.push('');
  for (const section of p.bodyTextSections) {
    out.push(section);
    out.push('');
  }
  out.push(`Zur Reise-Seite: ${p.participantPageUrl}`);
  out.push('');
  const orgAttribution = p.organiserName
    ? `${p.organiserName} diese Abstimmung für ${dest} erstellt hat`
    : `jemand eine when-we-go-Abstimmung für ${dest} erstellt hat`;
  out.push(`Du bekommst diese Mail, weil ${orgAttribution}.`);
  return out.join('\n');
}

// ─── T-30 ─────────────────────────────────────────────────────────────────

export interface T30Params {
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile | null;
  tripStartIso: string;
  /** Refreshed flight options (Phase 5 will populate; Phase 9 passes []). */
  flightsRefreshed?: FlightOption[];
  hotels?: HotelOption[];
  siteUrl: string;
  participantPageUrl: string;
  organiserName?: string;
}

export function renderT30Email(params: T30Params): RenderedEmail {
  const dest = params.poll.destination ?? params.poll.title;
  const subject = `🗓 ${dest} in 1 Monat — aktualisierte Infos`;
  const flights = params.flightsRefreshed ?? [];
  const hotels = params.hotels ?? [];

  const bodyHtmlSections: string[] = [];
  const bodyTextSections: string[] = [];

  if (flights.length > 0) {
    const rows = flights
      .map(
        (f) => `
          <tr>
            <td style="padding:8px 0;border-top:1px solid #eee;font-size:14px;">
              <strong>${esc(f.from)}</strong> → <strong>${esc(f.to)}</strong>
              ${f.carrier ? ` · ${esc(f.carrier)}` : ''}
              ${f.priceEur ? ` · €${f.priceEur}` : ''}
              ${f.url ? ` · <a href="${esc(f.url)}" style="color:#6750a4;">buchen</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            ✈️ Flüge — heute aktualisiert
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows}
          </table>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      'Flüge — heute aktualisiert:\n' +
        flights
          .map(
            (f) =>
              `  ${f.from} → ${f.to}${f.carrier ? ' · ' + f.carrier : ''}${
                f.priceEur ? ' · €' + f.priceEur : ''
              }${f.url ? ' [' + f.url + ']' : ''}`
          )
          .join('\n')
    );
  } else {
    // Graceful note when Phase 5 hasn't shipped yet.
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <p style="margin:0;font-size:14px;line-height:1.5;color:#666;">
            Die Flugpreise werden bald aktualisiert — halt die Augen offen. Bei größeren Preissprüngen melden wir uns per Telegram, falls du das eingerichtet hast.
          </p>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      'Die Flugpreise werden bald aktualisiert — halt die Augen offen.'
    );
  }

  if (hotels.length > 0) {
    const rows = hotels
      .map(
        (h) => `
          <tr>
            <td style="padding:8px 0;border-top:1px solid #eee;font-size:14px;">
              <strong>${esc(h.name)}</strong>
              ${h.area ? ` · ${esc(h.area)}` : ''}
              ${h.pricePerNightEur ? ` · €${h.pricePerNightEur}/Nacht` : ''}
              ${h.url ? ` · <a href="${esc(h.url)}" style="color:#6750a4;">ansehen</a>` : ''}
            </td>
          </tr>
        `
      )
      .join('');
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🏨 Hotels in der Auswahl
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows}
          </table>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      'Hotels in der Auswahl:\n' +
        hotels
          .map(
            (h) =>
              `  ${h.name}${h.area ? ' · ' + h.area : ''}${
                h.pricePerNightEur ? ' · €' + h.pricePerNightEur + '/Nacht' : ''
              }${h.url ? ' [' + h.url + ']' : ''}`
          )
          .join('\n')
    );
  }

  const shell: ReminderShellParams = {
    poll: params.poll,
    participant: params.participant,
    siteUrl: params.siteUrl,
    participantPageUrl: params.participantPageUrl,
    organiserName: params.organiserName,
    headline: `Hey ${params.participant.name} — ${dest} in 1 Monat.`,
    subheadline: 'Die Reise startet am ' + params.tripStartIso + '. Kurzes Update zu Preisen + Plänen.',
    bodyHtmlSections,
    bodyTextSections,
  };

  return {
    subject,
    html: buildReminderHtmlShell(shell, subject),
    text: buildReminderTextShell(shell),
    attachments: [],
  };
}

// ─── T-7 ──────────────────────────────────────────────────────────────────

export interface T7Params {
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile | null;
  tripStartIso: string;
  /** Open-Meteo 7-day forecast; null on fetch failure → graceful note. */
  weatherForecast?: Forecast | null;
  activities?: ActivitiesBucket;
  siteUrl: string;
  participantPageUrl: string;
  organiserName?: string;
}

export function renderT7Email(params: T7Params): RenderedEmail {
  const dest = params.poll.destination ?? params.poll.title;
  const subject = `🎒 ${dest} nächste Woche — kurze Checkliste`;
  const forecast = params.weatherForecast ?? null;
  const activities = params.activities ?? {};

  const bodyHtmlSections: string[] = [];
  const bodyTextSections: string[] = [];

  // Weather block
  if (forecast && forecast.daily.length > 0) {
    const rows = forecast.daily
      .map((d) => {
        const tMax = d.tempMaxC !== null ? `${Math.round(d.tempMaxC)}°` : '—';
        const tMin = d.tempMinC !== null ? `${Math.round(d.tempMinC)}°` : '—';
        const precip =
          d.precipProbPct !== null ? `${Math.round(d.precipProbPct)}%` : '—';
        return `
          <tr>
            <td style="padding:6px 8px;border-top:1px solid #eee;font-size:13px;">
              ${esc(d.date)}
            </td>
            <td style="padding:6px 8px;border-top:1px solid #eee;font-size:13px;">
              ${esc(weatherCodeLabel(d.weatherCode))}
            </td>
            <td style="padding:6px 8px;border-top:1px solid #eee;font-size:13px;text-align:right;">
              ${tMin} / ${tMax}
            </td>
            <td style="padding:6px 8px;border-top:1px solid #eee;font-size:13px;text-align:right;">
              ${precip}
            </td>
          </tr>
        `;
      })
      .join('');
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🌤️ Wettervorhersage — ${esc(forecast.destination)}
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
            <tr style="color:#666;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">
              <td style="padding:0 8px 6px 8px;">Datum</td>
              <td style="padding:0 8px 6px 8px;">Wetter</td>
              <td style="padding:0 8px 6px 8px;text-align:right;">Tief / Hoch</td>
              <td style="padding:0 8px 6px 8px;text-align:right;">Regen</td>
            </tr>
            ${rows}
          </table>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      `Wettervorhersage — ${forecast.destination}:\n` +
        forecast.daily
          .map(
            (d) =>
              `  ${d.date}: ${weatherCodeLabel(d.weatherCode)} ` +
              `${d.tempMinC !== null ? Math.round(d.tempMinC) + '°' : '—'} / ` +
              `${d.tempMaxC !== null ? Math.round(d.tempMaxC) + '°' : '—'} · ` +
              `Regen ${d.precipProbPct !== null ? Math.round(d.precipProbPct) + '%' : '—'}`
          )
          .join('\n')
    );
  } else {
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <p style="margin:0;font-size:14px;line-height:1.5;color:#666;">
            Wir konnten diese Woche keine aktuelle Wettervorhersage für ${esc(dest)} laden — schau für den ${esc(params.tripStartIso)} in deine bevorzugte Wetter-App.
          </p>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      `Wir konnten diese Woche keine aktuelle Wettervorhersage für ${dest} laden — schau für den ${params.tripStartIso} in deine bevorzugte Wetter-App.`
    );
  }

  // Packing checklist — generic, no API
  const packing = [
    'Reisepass / Ausweis',
    'Handy-Ladegerät + Adapter',
    'Wetterfeste Kleidung (siehe Vorhersage oben)',
    'Bequeme Schuhe zum Laufen',
    'Wiederverwendbare Trinkflasche',
    'Medikamente + kleine Reiseapotheke',
    'Bargeld + Karten',
    'Reiseversicherungs-Unterlagen',
  ];
  bodyHtmlSections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
          🎒 Packliste
        </h2>
        <ul style="margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.6;">
          ${packing.map((p) => `<li>${esc(p)}</li>`).join('')}
        </ul>
      </td>
    </tr>
  `);
  bodyTextSections.push(
    'Packliste:\n' + packing.map((p) => `  - ${p}`).join('\n')
  );

  // Activities reminder (only if non-empty)
  const allActs = [
    ...(activities.thisWeek ?? []),
    ...(activities.alwaysGreat ?? []),
  ];
  if (allActs.length > 0) {
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🎭 Aktivitäten
          </h2>
          <ul style="margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.5;">
            ${allActs
              .map(
                (a) =>
                  `<li>${esc(a.name)}${
                    a.url ? ` · <a href="${esc(a.url)}" style="color:#6750a4;">Info</a>` : ''
                  }</li>`
              )
              .join('')}
          </ul>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      'Aktivitäten:\n' +
        allActs.map((a) => `  - ${a.name}${a.url ? ' [' + a.url + ']' : ''}`).join('\n')
    );
  }

  const shell: ReminderShellParams = {
    poll: params.poll,
    participant: params.participant,
    siteUrl: params.siteUrl,
    participantPageUrl: params.participantPageUrl,
    organiserName: params.organiserName,
    headline: `Hey ${params.participant.name} — ${dest} nächste Woche.`,
    subheadline: 'Die Reise startet am ' + params.tripStartIso + '. Zeit zu packen.',
    bodyHtmlSections,
    bodyTextSections,
  };

  return {
    subject,
    html: buildReminderHtmlShell(shell, subject),
    text: buildReminderTextShell(shell),
    attachments: [],
  };
}

// ─── T-1 ──────────────────────────────────────────────────────────────────

export interface T1Params {
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile | null;
  tripStartIso: string;
  /** Hotel chosen by organiser (Phase 6 will set; null falls back gracefully). */
  chosenHotel?: HotelOption | null;
  siteUrl: string;
  participantPageUrl: string;
  organiserName?: string;
}

export function renderT1Email(params: T1Params): RenderedEmail {
  const dest = params.poll.destination ?? params.poll.title;
  const subject = `✈️ ${dest} morgen!`;

  const bodyHtmlSections: string[] = [];
  const bodyTextSections: string[] = [];

  // Hotel block (if Phase 6 has a chosen hotel)
  if (params.chosenHotel) {
    const h = params.chosenHotel;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${h.name} ${params.poll.destination ?? ''}`
    )}`;
    bodyHtmlSections.push(`
      <tr>
        <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
          <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
            🏨 Wo du wohnst
          </h2>
          <p style="margin:0 0 6px 0;font-size:16px;font-weight:700;">${esc(h.name)}</p>
          ${h.area ? `<p style="margin:0 0 6px 0;font-size:14px;color:#666;">${esc(h.area)}</p>` : ''}
          <p style="margin:8px 0 0 0;font-size:14px;">
            <a href="${esc(mapsUrl)}" style="color:#6750a4;font-weight:700;">In Google Maps öffnen →</a>
          </p>
        </td>
      </tr>
    `);
    bodyTextSections.push(
      `Wo du wohnst: ${h.name}${h.area ? ' · ' + h.area : ''}\nMaps: ${mapsUrl}`
    );
  }

  // Transit hint — generic, no API
  bodyHtmlSections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
          🚇 Anreise
        </h2>
        <p style="margin:0;font-size:14px;line-height:1.5;color:#444;">
          In den meisten Städten fährt eine Metro oder ein Bus vom Zentrum zum
          Flughafen — plan 90 Minuten von Tür zu Tür ein, inklusive Sicherheitskontrolle.
          Speicher den Boarding-Pass in deinem Handy-Wallet oder druck ihn heute Abend aus.
        </p>
      </td>
    </tr>
  `);
  bodyTextSections.push(
    "Anreise:\n  In den meisten Städten fährt eine Metro oder ein Bus vom Zentrum zum Flughafen — plan 90 Minuten von Tür zu Tür ein. Speicher deinen Boarding-Pass in deinem Handy-Wallet oder druck ihn heute Abend aus."
  );

  // Final checklist
  const finalChecklist = [
    'Boarding-Pass gespeichert / ausgedruckt',
    'Screenshot der Hotel-Adresse (offline lesbar)',
    'Handy voll geladen + Powerbank',
    'Reiseversicherungs-Unterlagen im Postfach',
    'Geldbeutel, Reisepass, Schlüssel, Ladegerät — heute Abend final checken',
  ];
  bodyHtmlSections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">
          ✅ Letzte Checks
        </h2>
        <ul style="margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.6;">
          ${finalChecklist.map((c) => `<li>${esc(c)}</li>`).join('')}
        </ul>
      </td>
    </tr>
  `);
  bodyTextSections.push(
    'Letzte Checks:\n' + finalChecklist.map((c) => `  - ${c}`).join('\n')
  );

  const shell: ReminderShellParams = {
    poll: params.poll,
    participant: params.participant,
    siteUrl: params.siteUrl,
    participantPageUrl: params.participantPageUrl,
    organiserName: params.organiserName,
    headline: `${dest} morgen, ${params.participant.name}!`,
    subheadline: 'Letzte Details hier.',
    bodyHtmlSections,
    bodyTextSections,
  };

  return {
    subject,
    html: buildReminderHtmlShell(shell, subject),
    text: buildReminderTextShell(shell),
    attachments: [],
  };
}

// ─── T+1 ──────────────────────────────────────────────────────────────────

export interface TPlus1Params {
  poll: Poll;
  participant: Participant;
  profile: ParticipantProfile | null;
  tripStartIso: string;
  siteUrl: string;
  participantPageUrl: string;
  organiserName?: string;
}

export function renderTPlus1Email(params: TPlus1Params): RenderedEmail {
  const dest = params.poll.destination ?? params.poll.title;
  const subject = `War ${dest} schön? Lust auf die nächste Reise?`;

  const bodyHtmlSections: string[] = [];
  const bodyTextSections: string[] = [];

  bodyHtmlSections.push(`
    <tr>
      <td style="padding:20px 24px 8px 24px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1c1b1f;">
        <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">
          Hoffentlich war's schön. Wenn etwas besonders gut (oder schief) gelaufen ist, sag ${
            params.organiserName ? esc(params.organiserName) : 'deinem Organisator'
          } Bescheid, damit die nächste Reise noch besser wird.
        </p>
        <p style="margin:0;font-size:15px;line-height:1.6;">
          Lust auf die nächste Reise? Starte jederzeit eine neue when-we-go-Abstimmung —
          <a href="${esc(params.siteUrl)}/" style="color:#6750a4;font-weight:700;">${esc(params.siteUrl)}</a>.
        </p>
      </td>
    </tr>
  `);
  bodyTextSections.push(
    `Hoffentlich war's schön. Wenn etwas besonders gut (oder schief) gelaufen ist, sag ${
      params.organiserName ?? 'deinem Organisator'
    } Bescheid, damit die nächste Reise noch besser wird.`
  );
  bodyTextSections.push(`Lust auf die nächste Reise? ${params.siteUrl}/`);

  const shell: ReminderShellParams = {
    poll: params.poll,
    participant: params.participant,
    siteUrl: params.siteUrl,
    participantPageUrl: params.participantPageUrl,
    organiserName: params.organiserName,
    headline: `Willkommen zurück, ${params.participant.name}.`,
    subheadline: `Hoffentlich hat ${dest} geliefert.`,
    bodyHtmlSections,
    bodyTextSections,
  };

  return {
    subject,
    html: buildReminderHtmlShell(shell, subject),
    text: buildReminderTextShell(shell),
    attachments: [],
  };
}
