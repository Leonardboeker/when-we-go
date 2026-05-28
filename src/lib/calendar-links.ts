// src/lib/calendar-links.ts
// Client-side mirror of worker/lib/calendar-links.ts so Astro components can
// render the same "Add to Calendar" buttons without bundling worker code.
//
// Kept identical to the worker version — when you edit one, edit the other.
// (We could share via a third location, but Astro + Workers have different
// build pipelines and the file is tiny.)

export interface CalendarLinkInput {
  title: string;
  startDateIso: string;
  endDateExclusiveIso: string;
  description: string;
  location: string;
}

function packCompact(iso: string): string {
  return `${iso.replace(/-/g, '')}T000000Z`;
}

function packIso(iso: string): string {
  return `${iso}T00:00:00Z`;
}

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
  apple: string;
  ical: string;
}

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
