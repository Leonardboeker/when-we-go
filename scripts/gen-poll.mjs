// scripts/gen-poll.mjs
// CLI: generate a fresh poll JSON entry (organizer token + N participant tokens)
// ready to paste into data/polls.json.
//
// Usage:
//   node scripts/gen-poll.mjs \
//     --slug copenhagen-2026 \
//     --title "Copenhagen — family trip" \
//     --destination "Copenhagen, Denmark" \
//     --start 2026-06-01 \
//     --end   2026-09-30 \
//     --close 2026-05-30T23:59:59+02:00 \
//     --participants "Alice,Bob,Carol"
//
//   node scripts/gen-poll.mjs --admin       # prints a fresh organizer token only
//
import { parseArgs } from 'node:util';
import { nanoid } from 'nanoid';

const PARTICIPANT_TOKEN_LENGTH = 16;
const ORGANIZER_TOKEN_LENGTH = 22;

const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  '404',
  'favicon',
  'robots',
  'sitemap',
  'og',
]);

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    title: { type: 'string' },
    destination: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    close: { type: 'string' },
    participants: { type: 'string' },
    admin: { type: 'boolean' },
  },
});

if (values.admin) {
  console.log(nanoid(ORGANIZER_TOKEN_LENGTH));
  process.exit(0);
}

function fatal(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

if (!values.slug || !values.title || !values.start || !values.end || !values.close || !values.participants) {
  console.error('Usage: node scripts/gen-poll.mjs --slug copenhagen-2026 --title "Copenhagen trip" --start 2026-06-01 --end 2026-09-30 --close 2026-05-30T23:59:59+02:00 --participants "Alice,Bob,Carol"');
  console.error('       node scripts/gen-poll.mjs --admin   (prints a fresh organizer token)');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(values.slug)) {
  fatal(`--slug "${values.slug}" must be URL-safe (lowercase a-z, 0-9, hyphens)`);
}
if (RESERVED_SLUGS.has(values.slug)) {
  fatal(`--slug "${values.slug}" is reserved (one of: ${[...RESERVED_SLUGS].join(', ')})`);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(values.start)) {
  fatal(`--start "${values.start}" must be YYYY-MM-DD`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(values.end)) {
  fatal(`--end "${values.end}" must be YYYY-MM-DD`);
}
if (Date.parse(values.end) < Date.parse(values.start)) {
  fatal('--end is before --start');
}
if (!Number.isFinite(Date.parse(values.close))) {
  fatal(`--close "${values.close}" is not a valid ISO timestamp`);
}

const names = values.participants.split(',').map((n) => n.trim()).filter(Boolean);
if (names.length === 0) {
  fatal('--participants is empty after parsing');
}

const seenTokens = new Set();
const organizerToken = nanoid(ORGANIZER_TOKEN_LENGTH);
seenTokens.add(organizerToken);

const participants = names.map((name) => {
  let token;
  do {
    token = nanoid(PARTICIPANT_TOKEN_LENGTH);
  } while (seenTokens.has(token));
  seenTokens.add(token);
  return { token, name };
});

const poll = {
  slug: values.slug,
  title: values.title,
  ...(values.destination ? { destination: values.destination } : {}),
  dateRangeStart: values.start,
  dateRangeEnd: values.end,
  pollCloseAt: values.close,
  organizerToken,
  participants,
  createdAt: new Date().toISOString(),
};

// Print the JSON object ready to paste into data/polls.json
console.log(JSON.stringify(poll, null, 2));

// Print URL hints to stderr so the JSON on stdout stays clean for piping
const baseUrl = process.env.SITE_BASE_URL || 'https://YOUR-DOMAIN.com';
console.error('');
console.error(`Admin URL: ${baseUrl}/${poll.slug}/admin/${organizerToken}/`);
for (const p of participants) {
  console.error(`${p.name.padEnd(20)} ${baseUrl}/${poll.slug}/${p.token}/`);
}
