// worker/lib/calendar-links.ts
// Pure helpers that build add-to-calendar deep-links for Google, Outlook (web),
// Yahoo, and Apple Calendar. No OAuth, no SDK — just URL builders the email
// template + per-token page can drop into href attributes.
//
// Date conventions:
//   - All inputs are ISO `YYYY-MM-DD` (all-day events).
//   - We render all-day events: 00:00 → next-day 00:00 in UTC.
//   - The `endDateExclusiveIso` is what the caller computes (e.g. trip ends
//     Jul 15 inclusive → caller passes Jul 16 for `endDateExclusiveIso`).
//
// Google/Yahoo want compact `YYYYMMDDTHHMMSSZ`. Outlook wants ISO 8601 with
// `Z` (e.g. `2026-07-12T00:00:00Z`). Apple just downloads the .ics.

export interface CalendarLinkInput {
  title: string;
  /** Inclusive trip start, ISO YYYY-MM-DD. */
  startDateIso: string;
  /** EXCLUSIVE trip end (caller pre-computes from inclusive end + 1 day). */
  endDateExclusiveIso: string;
  /** Free-form, may contain links + newlines. */
  description: string;
  location: string;
}

/** Pack `YYYY-MM-DD` into Google/Yahoo's `YYYYMMDDTHHMMSSZ` (midnight UTC). */
function packCompact(iso: string): string {
  return `${iso.replace(/-/g, '')}T000000Z`;
}

/** Pack `YYYY-MM-DD` into Outlook's ISO-8601 form (`...T00:00:00Z`). */
function packIso(iso: string): string {
  return `${iso}T00:00:00Z`;
}

/**
 * https://calendar.google.com/calendar/render?action=TEMPLATE&...
 * `dates=START/END` with END exclusive (Google's all-day convention matches RFC).
 */
export function buildGoogleCalendarUrl(input: CalendarLinkInput): string {
  const dates = `${packCompact(input.startDateIso)}/${packCompact(input.endDateExclusiveIso)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates,
    details: input.description,
    location: input.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * https://outlook.live.com/calendar/0/deeplink/compose?...
 * Outlook is the most picky about timestamps — give it strict ISO 8601 with Z.
 */
export function buildOutlookUrl(input: CalendarLinkInput): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.title,
    startdt: packIso(input.startDateIso),
    enddt: packIso(input.endDateExclusiveIso),
    body: input.description,
    location: input.location,
    allday: 'true',
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/**
 * https://calendar.yahoo.com/?v=60&...
 * Yahoo uses `st` / `et` with the same `YYYYMMDDTHHMMSSZ` format as Google.
 */
export function buildYahooUrl(input: CalendarLinkInput): string {
  const params = new URLSearchParams({
    v: '60',
    title: input.title,
    st: packCompact(input.startDateIso),
    et: packCompact(input.endDateExclusiveIso),
    desc: input.description,
    in_loc: input.location,
  });
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

/**
 * Apple Calendar handles `.ics` files natively — clicking the link prompts
 * macOS / iOS to import the event. So the "Apple" button just points at the
 * public .ics URL.
 */
export function buildICalDownloadUrl(args: {
  siteUrl: string;
  slug: string;
}): string {
  return `${args.siteUrl.replace(/\/$/, '')}/ical/${args.slug}.ics`;
}

export interface AddToCalendarLinks {
  google: string;
  outlook: string;
  yahoo: string;
  apple: string; // same as ical download URL
  ical: string;
}

/**
 * Convenience: build all four add-to-calendar URLs at once.
 * Caller still needs to supply the site URL separately for Apple/ical.
 */
export function buildAllCalendarLinks(args: {
  input: CalendarLinkInput;
  siteUrl: string;
  slug: string;
}): AddToCalendarLinks {
  const ical = buildICalDownloadUrl({ siteUrl: args.siteUrl, slug: args.slug });
  return {
    google: buildGoogleCalendarUrl(args.input),
    outlook: buildOutlookUrl(args.input),
    yahoo: buildYahooUrl(args.input),
    apple: ical,
    ical,
  };
}
