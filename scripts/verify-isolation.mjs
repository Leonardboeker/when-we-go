// scripts/verify-isolation.mjs
// Verifies cross-poll + cross-participant isolation in the built static site.
//
// For each PARTICIPANT page (dist/<slug>/<token>/index.html):
//   - MUST contain the participant's own name
//   - MUST NOT contain any other participant's name from ANY poll (this poll
//     included — Phase 1 per-token pages are single-participant-scoped)
//   - MUST NOT contain any other poll's slug, title, or destination
//
// For each ADMIN page (dist/<slug>/admin/<organizerToken>/index.html):
//   - MUST contain every participant name from its own poll (admin sees the list)
//   - MUST NOT contain any participant name, slug, title, or destination from
//     any OTHER poll
//
// Hard-fails on any leak. Run after `npm run build`.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist');
const dataFile = resolve(process.cwd(), 'data/polls.json');

if (!existsSync(distDir)) {
  console.error('FATAL: dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(dataFile)) {
  console.error('FATAL: data/polls.json does not exist.');
  process.exit(1);
}

const polls = JSON.parse(readFileSync(dataFile, 'utf8'));
if (!Array.isArray(polls) || polls.length === 0) {
  console.error('FATAL: data/polls.json is empty or not an array.');
  process.exit(1);
}

let failed = 0;
let checked = 0;

// Escape a string for safe use inside a RegExp literal.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary substring match. Plain `html.includes(name)` matches "Leo"
// inside "Leonardboeker" (the GitHub username in the BaseLayout footer link),
// which is a false-positive: that string is structural, not personal.
// Word-boundary regex keeps real-name leaks visible while ignoring those.
function htmlContainsWord(html, needle) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(needle)}(?:$|[^A-Za-z0-9])`);
  return re.test(html);
}

// Plain substring — used for tokens + slugs (no word-boundary concerns).
function htmlContains(html, needle) {
  return html.includes(needle);
}

// ─── 1. Per-participant pages ─────────────────────────────────────
for (const poll of polls) {
  for (const me of poll.participants) {
    const file = join(distDir, poll.slug, me.token, 'index.html');
    if (!existsSync(file)) {
      console.error('MISSING:', file);
      failed++;
      continue;
    }
    const html = readFileSync(file, 'utf8');
    checked++;

    if (!htmlContainsWord(html, me.name)) {
      console.error(`LEAK: ${file} — missing own name "${me.name}"`);
      failed++;
    }

    // Other participants in the SAME poll: must not appear on this page.
    for (const other of poll.participants) {
      if (other.token === me.token) continue;
      if (htmlContainsWord(html, other.name)) {
        console.error(`LEAK: ${file} — contains co-participant name "${other.name}" from same poll`);
        failed++;
      }
    }

    // Any other poll's data: must not appear.
    for (const otherPoll of polls) {
      if (otherPoll.slug === poll.slug) continue;
      if (htmlContains(html, otherPoll.slug)) {
        console.error(`LEAK: ${file} — contains other poll slug "${otherPoll.slug}"`);
        failed++;
      }
      if (htmlContains(html, otherPoll.title)) {
        console.error(`LEAK: ${file} — contains other poll title "${otherPoll.title}"`);
        failed++;
      }
      if (otherPoll.destination && htmlContains(html, otherPoll.destination)) {
        console.error(`LEAK: ${file} — contains other poll destination "${otherPoll.destination}"`);
        failed++;
      }
      for (const otherP of otherPoll.participants) {
        if (htmlContainsWord(html, otherP.name)) {
          console.error(`LEAK: ${file} — contains participant "${otherP.name}" from other poll "${otherPoll.slug}"`);
          failed++;
        }
        if (htmlContains(html, otherP.token)) {
          console.error(`LEAK: ${file} — contains participant token from other poll "${otherPoll.slug}"`);
          failed++;
        }
      }
    }
  }
}

// ─── 2. Admin pages ────────────────────────────────────────────────
for (const poll of polls) {
  const file = join(distDir, poll.slug, 'admin', poll.organizerToken, 'index.html');
  if (!existsSync(file)) {
    console.error('MISSING:', file);
    failed++;
    continue;
  }
  const html = readFileSync(file, 'utf8');
  checked++;

  // Admin page must list every own participant.
  for (const own of poll.participants) {
    if (!htmlContainsWord(html, own.name)) {
      console.error(`LEAK: ${file} — missing own participant "${own.name}"`);
      failed++;
    }
  }

  // Other polls' data must not appear.
  for (const otherPoll of polls) {
    if (otherPoll.slug === poll.slug) continue;
    if (htmlContains(html, otherPoll.slug)) {
      console.error(`LEAK: ${file} — admin page contains other poll slug "${otherPoll.slug}"`);
      failed++;
    }
    if (htmlContains(html, otherPoll.title)) {
      console.error(`LEAK: ${file} — admin page contains other poll title "${otherPoll.title}"`);
      failed++;
    }
    if (otherPoll.destination && htmlContains(html, otherPoll.destination)) {
      console.error(`LEAK: ${file} — admin page contains other poll destination "${otherPoll.destination}"`);
      failed++;
    }
    for (const otherP of otherPoll.participants) {
      if (htmlContainsWord(html, otherP.name)) {
        console.error(`LEAK: ${file} — admin page contains participant "${otherP.name}" from other poll "${otherPoll.slug}"`);
        failed++;
      }
      if (htmlContains(html, otherP.token)) {
        console.error(`LEAK: ${file} — admin page contains token from other poll "${otherPoll.slug}"`);
        failed++;
      }
    }
  }
}

if (failed > 0) {
  console.error(`FAILED isolation checks: ${failed} (out of ${checked} pages checked)`);
  process.exit(1);
}
console.log(`Isolation verified for ${polls.length} poll(s), ${checked} page(s).`);
