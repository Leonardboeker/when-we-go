// scripts/prebuild-polls.mjs
// Phase 1 prebuild: materialise data/polls.json from one of:
//   1. existing data/polls.json (local dev — file is gitignored)
//   2. WHENWEGO_POLLS_JSON env var (CI — Cloudflare Pages dashboard)
// Then validate the resulting shape so the Astro build can't fail mid-render
// on a missing key 30 seconds in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'data/polls.json');

// Slugs that would collide with our route table (or with framework paths).
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  '404',
  'favicon',
  'robots',
  'sitemap',
  'og',
]);

const REQUIRED_POLL_KEYS = [
  'slug',
  'title',
  'dateRangeStart',
  'dateRangeEnd',
  'pollCloseAt',
  'organizerToken',
  'participants',
  'createdAt',
];

const REQUIRED_PARTICIPANT_KEYS = ['token', 'name'];

function fatal(msg) {
  console.error(`[prebuild] FATAL: ${msg}`);
  process.exit(1);
}

function isIsoDate(value) {
  // YYYY-MM-DD (lenient — Date.parse rules out fully-bogus values)
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function validatePolls(parsed) {
  if (!Array.isArray(parsed)) fatal('polls payload must be a JSON array');
  if (parsed.length === 0) fatal('polls payload is an empty array');

  const seenSlugs = new Set();
  const seenTokens = new Set();

  for (const [idx, p] of parsed.entries()) {
    if (!p || typeof p !== 'object') fatal(`poll[${idx}] is not an object`);

    for (const key of REQUIRED_POLL_KEYS) {
      if (!(key in p)) fatal(`poll[${idx}] missing required key: ${key}`);
    }

    if (typeof p.slug !== 'string' || p.slug.length === 0) {
      fatal(`poll[${idx}].slug must be a non-empty string`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.slug)) {
      fatal(
        `poll[${idx}].slug "${p.slug}" must be URL-safe (lowercase a-z, 0-9, hyphens)`
      );
    }
    if (RESERVED_SLUGS.has(p.slug)) {
      fatal(`poll[${idx}].slug "${p.slug}" is reserved (one of: ${[...RESERVED_SLUGS].join(', ')})`);
    }
    if (seenSlugs.has(p.slug)) fatal(`duplicate poll slug: ${p.slug}`);
    seenSlugs.add(p.slug);

    if (typeof p.title !== 'string' || p.title.trim().length === 0) {
      fatal(`poll[${idx}].title must be a non-empty string`);
    }

    if (!isIsoDate(p.dateRangeStart)) {
      fatal(`poll[${idx}].dateRangeStart "${p.dateRangeStart}" is not a valid ISO YYYY-MM-DD date`);
    }
    if (!isIsoDate(p.dateRangeEnd)) {
      fatal(`poll[${idx}].dateRangeEnd "${p.dateRangeEnd}" is not a valid ISO YYYY-MM-DD date`);
    }
    if (Date.parse(p.dateRangeEnd) < Date.parse(p.dateRangeStart)) {
      fatal(`poll[${idx}].dateRangeEnd is before dateRangeStart`);
    }
    if (!isIsoTimestamp(p.pollCloseAt)) {
      fatal(`poll[${idx}].pollCloseAt "${p.pollCloseAt}" is not a valid ISO timestamp`);
    }
    if (!isIsoTimestamp(p.createdAt)) {
      fatal(`poll[${idx}].createdAt "${p.createdAt}" is not a valid ISO timestamp`);
    }

    if (typeof p.organizerToken !== 'string' || p.organizerToken.length === 0) {
      fatal(`poll[${idx}].organizerToken must be a non-empty string`);
    }
    if (seenTokens.has(p.organizerToken)) {
      fatal(`duplicate token across polls: ${p.organizerToken}`);
    }
    seenTokens.add(p.organizerToken);

    if (!Array.isArray(p.participants) || p.participants.length === 0) {
      fatal(`poll[${idx}].participants must be a non-empty array`);
    }

    for (const [pi, person] of p.participants.entries()) {
      if (!person || typeof person !== 'object') {
        fatal(`poll[${idx}].participants[${pi}] is not an object`);
      }
      for (const key of REQUIRED_PARTICIPANT_KEYS) {
        if (!(key in person)) {
          fatal(`poll[${idx}].participants[${pi}] missing required key: ${key}`);
        }
      }
      if (typeof person.token !== 'string' || person.token.length === 0) {
        fatal(`poll[${idx}].participants[${pi}].token must be a non-empty string`);
      }
      if (typeof person.name !== 'string' || person.name.trim().length === 0) {
        fatal(`poll[${idx}].participants[${pi}].name must be a non-empty string`);
      }
      if (person.token === p.organizerToken) {
        fatal(`poll[${idx}].participants[${pi}].token collides with organizerToken`);
      }
      if (seenTokens.has(person.token)) {
        fatal(`duplicate token across polls: ${person.token}`);
      }
      seenTokens.add(person.token);
    }
  }
}

// ─── 1. Resolve source ──────────────────────────────────────────────
let parsed;

if (existsSync(TARGET)) {
  console.log('[prebuild] data/polls.json already exists — using local file.');
  try {
    parsed = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch (err) {
    fatal(`data/polls.json is not valid JSON: ${err.message}`);
  }
} else {
  const json = process.env.WHENWEGO_POLLS_JSON;
  if (!json) {
    console.error('[prebuild] FATAL: data/polls.json missing AND WHENWEGO_POLLS_JSON env var not set.');
    console.error('[prebuild] Local dev: copy data/polls.example.json → data/polls.json and edit, or run `npm run gen-poll`.');
    console.error('[prebuild] CI: set WHENWEGO_POLLS_JSON in the Cloudflare Pages dashboard.');
    process.exit(1);
  }
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    fatal(`WHENWEGO_POLLS_JSON is not valid JSON: ${err.message}`);
  }
}

// ─── 2. Validate shape ──────────────────────────────────────────────
validatePolls(parsed);

// ─── 3. Persist materialised file ───────────────────────────────────
writeFileSync(TARGET, JSON.stringify(parsed, null, 2));
console.log(
  `[prebuild] Wrote ${parsed.length} poll${parsed.length === 1 ? '' : 's'} (${parsed.reduce(
    (sum, p) => sum + p.participants.length,
    0
  )} participants) to data/polls.json`
);
