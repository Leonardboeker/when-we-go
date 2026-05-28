// scripts/smoke-test.mjs
// End-to-end smoke checklist for the when-we-go Worker API. Runs against any
// HTTP base (local wrangler dev or deployed Worker) in < 10 s.
//
// Usage:
//   SMOKE_BASE=http://localhost:8787 \
//   SMOKE_TOKENS="EXAMPLE_TOKEN_LEO_REPLACE:Leo" \
//   SMOKE_ORGANIZER_TOKEN=EXAMPLE_ORG_TOKEN_REPLACE \
//   SMOKE_SLUG=copenhagen-2026 \
//   npm run smoke
//
// Env:
//   SMOKE_BASE             Required. Worker base URL (no trailing slash).
//   SMOKE_SLUG             Optional. Defaults to copenhagen-2026.
//   SMOKE_TOKENS           Required for vote checks. "token:Name,token:Name".
//   SMOKE_ORGANIZER_TOKEN  Required for admin checks. The org token in plain text.
//
// Exit 0 if all pass, 1 on any failure.

const BASE = (process.env.SMOKE_BASE || '').replace(/\/$/, '');
const SLUG = process.env.SMOKE_SLUG || 'copenhagen-2026';
const RAW_TOKENS = process.env.SMOKE_TOKENS || '';
const ORG_TOKEN = process.env.SMOKE_ORGANIZER_TOKEN || '';

if (!BASE) {
  console.error('[smoke] SMOKE_BASE env var is required');
  process.exit(2);
}

const PARTICIPANTS = RAW_TOKENS
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [token, name] = pair.split(':');
    return { token: (token || '').trim(), name: (name || '').trim() };
  })
  .filter((p) => p.token);

let pass = 0;
let fail = 0;
let skipped = 0;

function ok(label) { console.log(`  PASS  ${label}`); pass++; }
function bad(label, why) { console.error(`  FAIL  ${label} — ${why}`); fail++; }
function skip(label, why) { console.log(`  SKIP  ${label} (${why})`); skipped++; }

async function check(label, fn) {
  try {
    const r = await fn();
    if (r === true) ok(label);
    else if (r && typeof r === 'object' && r.skip) skip(label, r.skip);
    else bad(label, typeof r === 'string' ? r : 'returned non-true');
  } catch (e) {
    bad(label, e.message || String(e));
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall-through */ }
  return { status: res.status, json, text };
}

async function fetchRaw(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const started = Date.now();
console.log(`\n[smoke] BASE=${BASE} SLUG=${SLUG}`);
console.log(`[smoke] participants: ${PARTICIPANTS.length || 'NONE (set SMOKE_TOKENS)'}`);
console.log(`[smoke] org token: ${ORG_TOKEN ? 'present' : 'MISSING (set SMOKE_ORGANIZER_TOKEN)'}`);
console.log('');

// (1) Health
console.log('(1) Health:');
await check('GET /api/health -> 200 { ok:true, phase:>=2 }', async () => {
  const { status, json } = await fetchJson(`${BASE}/api/health`);
  if (status !== 200) return `status ${status}`;
  if (!json || json.ok !== true) return 'ok flag missing';
  // Phase number can be any shipped phase (2, 4, 8, …) — just check it's a positive int.
  if (typeof json.phase !== 'number' || json.phase < 2) return `phase=${json.phase} expected >= 2`;
  return true;
});

// (2) Participant flow: POST /api/vote, GET /api/poll, malformed/closed
console.log('\n(2) Participant flow:');
if (PARTICIPANTS.length === 0) {
  await check('POST /api/vote with valid body', async () => ({ skip: 'no SMOKE_TOKENS' }));
} else {
  const me = PARTICIPANTS[0];

  await check(`POST /api/vote (${me.name}) -> 200 ok`, async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      votes: [
        { date: '2026-06-01', state: 'yes' },
        { date: '2026-06-02', state: 'maybe' },
        { date: '2026-06-03', state: 'no' },
      ],
    };
    const { status, json } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 200) return `status ${status} body=${JSON.stringify(json)}`;
    if (!json || json.ok !== true) return 'ok flag missing';
    if (json.voteCount !== 3) return `voteCount=${json.voteCount} expected 3`;
    return true;
  });

  await check('POST /api/vote with wrong token -> 401', async () => {
    const body = { slug: SLUG, token: 'WRONG_TOKEN_NEVER_VALID', votes: [] };
    const { status } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 401) return `status ${status} expected 401`;
    return true;
  });

  await check('POST /api/vote with missing slug -> 404', async () => {
    const body = { slug: 'never-existed-slug-zzz', token: me.token, votes: [] };
    const { status } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });

  await check('POST /api/vote with malformed body -> 400', async () => {
    const { status } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check('POST /api/vote with out-of-range date -> 400', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      votes: [{ date: '2024-01-01', state: 'yes' }],
    };
    const { status } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check(`GET /api/poll (${me.name}) -> 200 + correct shape`, async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/poll?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}`
    );
    if (status !== 200) return `status ${status}`;
    if (!json || !json.poll || json.poll.slug !== SLUG) return 'poll shape wrong';
    if (!Array.isArray(json.votes)) return 'votes not array';
    if (typeof json.closed !== 'boolean') return 'closed not boolean';
    return true;
  });
}

// (2b) Profile flow (Phase 4) — validation + persistence + read-back
console.log('\n(2b) Profile flow:');
if (PARTICIPANTS.length === 0) {
  await check('POST /api/profile', async () => ({ skip: 'no SMOKE_TOKENS' }));
} else {
  const me = PARTICIPANTS[0];

  await check('POST /api/profile with valid body -> 200 { ok, profileComplete:true }', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      profile: {
        email: 'smoke-test@example.com',
        homeAirport: 'MUC',
        homeCity: 'Munich',
        budgetMaxEur: 500,
        interests: ['food', 'museums'],
      },
    };
    const { status, json } = await fetchJson(`${BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 200) return `status ${status} body=${JSON.stringify(json)}`;
    if (!json || json.ok !== true) return 'ok flag missing';
    if (json.profileComplete !== true) return `profileComplete=${json.profileComplete} expected true`;
    return true;
  });

  await check('POST /api/profile with invalid email -> 400', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      profile: { email: 'not-an-email', homeAirport: 'MUC' },
    };
    const { status } = await fetchJson(`${BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check('POST /api/profile with invalid IATA (lowercase) -> 400', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      profile: { email: 'ok@example.com', homeAirport: 'muc' },
    };
    const { status } = await fetchJson(`${BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check('POST /api/profile with invalid IATA (4 letters) -> 400', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      profile: { homeAirport: 'MUCX' },
    };
    const { status } = await fetchJson(`${BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check('GET /api/poll after profile set -> viewer.profile present', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/poll?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}`
    );
    if (status !== 200) return `status ${status}`;
    if (!json || !json.viewer) return 'viewer missing';
    if (!json.viewer.profile) return 'viewer.profile missing';
    if (json.viewer.profile.email !== 'smoke-test@example.com') {
      return `email=${json.viewer.profile.email} expected smoke-test@example.com`;
    }
    if (json.viewer.profile.homeAirport !== 'MUC') {
      return `homeAirport=${json.viewer.profile.homeAirport} expected MUC`;
    }
    return true;
  });
}

// (3) Admin flow
console.log('\n(3) Admin flow:');
if (!ORG_TOKEN) {
  await check('GET /api/admin/poll', async () => ({ skip: 'no SMOKE_ORGANIZER_TOKEN' }));
} else {
  await check('GET /api/admin/poll with org token -> 200 + voterStatus + overlap + profileComplete', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/poll?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || !Array.isArray(json.voterStatus)) return 'voterStatus missing';
    if (!json.overlap || !json.overlap.perDate) return 'overlap missing';
    // Phase 4: every voter row must include a profileComplete boolean.
    for (const v of json.voterStatus) {
      if (typeof v.profileComplete !== 'boolean') {
        return `voter ${v.name} profileComplete not boolean (was ${typeof v.profileComplete})`;
      }
    }
    return true;
  });

  await check('GET /api/admin/poll with WRONG org token -> 404', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/poll?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': 'wrong-org-token-NEVER-valid' } }
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });

  await check('GET /api/admin/poll with NO org token header -> 404', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/poll?slug=${encodeURIComponent(SLUG)}`
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });
}

// (4) Close + post-close behaviour (uses ORG_TOKEN)
console.log('\n(4) Close flow:');
if (!ORG_TOKEN || PARTICIPANTS.length === 0) {
  await check('POST /api/admin/close', async () => ({ skip: 'needs SMOKE_ORGANIZER_TOKEN + SMOKE_TOKENS' }));
} else {
  await check('POST /api/admin/close -> 200 { ok, closedAt }', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/close?slug=${encodeURIComponent(SLUG)}`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || json.ok !== true) return 'ok missing';
    if (!json.closedAt && !json.alreadyClosed) return 'closedAt missing';
    return true;
  });

  const me = PARTICIPANTS[0];
  await check('POST /api/vote after close -> 410 Gone', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      votes: [{ date: '2026-06-01', state: 'no' }],
    };
    const { status } = await fetchJson(`${BASE}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 410) return `status ${status} expected 410`;
    return true;
  });

  await check('GET /api/poll post-close -> closed:true + overlap populated', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/poll?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}`
    );
    if (status !== 200) return `status ${status}`;
    if (!json || json.closed !== true) return 'closed flag not true';
    if (!json.overlap || !json.overlap.perDate) return 'overlap missing post-close';
    return true;
  });

  await check('POST /api/admin/close again -> 200 alreadyClosed:true (idempotent)', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/close?slug=${encodeURIComponent(SLUG)}`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || json.alreadyClosed !== true) return 'alreadyClosed not true';
    return true;
  });
}

// (5) Phase 8 — iCal + close-summary endpoints
console.log('\n(5) iCal + close-summary flow:');
if (PARTICIPANTS.length === 0) {
  await check('GET /api/ical', async () => ({ skip: 'no SMOKE_TOKENS' }));
} else {
  const me = PARTICIPANTS[0];

  await check('GET /api/ical?slug=X&token=Y -> 200 text/calendar starts with BEGIN:VCALENDAR', async () => {
    const { status, text, headers } = await fetchRaw(
      `${BASE}/api/ical?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}`
    );
    if (status !== 200) return `status ${status}`;
    const ct = headers.get('content-type') || '';
    if (!ct.includes('text/calendar')) return `Content-Type=${ct} expected text/calendar`;
    if (!text.startsWith('BEGIN:VCALENDAR')) return `body does not start with BEGIN:VCALENDAR; got: ${text.slice(0, 40)}`;
    if (!text.includes('END:VCALENDAR')) return 'body missing END:VCALENDAR';
    // 4 VALARM blocks present
    const alarms = (text.match(/BEGIN:VALARM/g) || []).length;
    if (alarms !== 4) return `expected 4 VALARM blocks, got ${alarms}`;
    return true;
  });

  await check('GET /api/ical with wrong token -> 404', async () => {
    const { status } = await fetchRaw(
      `${BASE}/api/ical?slug=${encodeURIComponent(SLUG)}&token=NEVER_VALID_TOKEN_zzz`
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });

  await check('GET /ical/<slug>.ics (public) -> 200 text/calendar, no ATTENDEE', async () => {
    const { status, text, headers } = await fetchRaw(
      `${BASE}/ical/${encodeURIComponent(SLUG)}.ics`
    );
    if (status !== 200) return `status ${status}`;
    const ct = headers.get('content-type') || '';
    if (!ct.includes('text/calendar')) return `Content-Type=${ct}`;
    if (!text.startsWith('BEGIN:VCALENDAR')) return 'body wrong';
    // Public form must NOT include an ATTENDEE block (privacy).
    if (text.includes('ATTENDEE')) return 'public .ics leaked ATTENDEE block';
    return true;
  });
}

// (6) Phase 8 — admin-resend-close-summary
console.log('\n(6) Admin resend-close-summary flow:');
if (!ORG_TOKEN || PARTICIPANTS.length === 0) {
  await check('POST /api/admin/resend-close-summary', async () => ({ skip: 'needs SMOKE_ORGANIZER_TOKEN + SMOKE_TOKENS' }));
} else {
  const me = PARTICIPANTS[0];

  // Ensure participant has an email on their profile so the resend has a target.
  await check('POST /api/profile (set test@nowhere.invalid for resend) -> 200', async () => {
    const body = {
      slug: SLUG,
      token: me.token,
      profile: {
        email: 'test@nowhere.invalid',
        homeAirport: 'MUC',
      },
    };
    const { status } = await fetchJson(`${BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (status !== 200) return `status ${status}`;
    return true;
  });

  await check('POST /api/admin/resend-close-summary -> 200 { ok, sent, skipped }', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/resend-close-summary?slug=${encodeURIComponent(SLUG)}`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status} body=${JSON.stringify(json)}`;
    if (!json || json.ok !== true) return 'ok flag missing';
    if (typeof json.sent !== 'number') return `sent not number: ${json.sent}`;
    if (typeof json.skipped !== 'number') return `skipped not number: ${json.skipped}`;
    // Real Resend integration check: at least one send should have been attempted
    // (the one for our test@nowhere.invalid participant). Resend will return 422
    // "can only send to verified addresses" in sandbox mode, which fanOut treats
    // as "sent" (the integration did run end-to-end).
    console.log(`        [info] resend result: sent=${json.sent} skipped=${json.skipped} errors=${JSON.stringify(json.errors)}`);
    if (json.sent + json.skipped === 0 && (json.errors || []).length === 0) {
      return 'no email send was attempted — Resend integration did not run';
    }
    return true;
  });

  await check('POST /api/admin/resend-close-summary with WRONG org token -> 404', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/resend-close-summary?slug=${encodeURIComponent(SLUG)}`,
      { method: 'POST', headers: { 'X-Organizer-Token': 'wrong-org-token-NEVER-valid' } }
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });
}

// (7) Phase 9 — reminders (status + force-send + clear)
console.log('\n(7) Reminder flow:');
if (!ORG_TOKEN || PARTICIPANTS.length === 0) {
  await check('GET /api/admin/reminder-status', async () => ({ skip: 'needs SMOKE_ORGANIZER_TOKEN + SMOKE_TOKENS' }));
} else {
  const me = PARTICIPANTS[0];

  await check('GET /api/admin/reminder-status with org token -> 200 + { ok, tripStart, status[] }', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/reminder-status?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || json.ok !== true) return 'ok flag missing';
    if (!Array.isArray(json.status)) return 'status not array';
    // tripStart should be a non-empty string post-close (we closed in step 4).
    if (typeof json.tripStart !== 'string' || !json.tripStart) {
      return `tripStart=${json.tripStart} expected non-empty string post-close`;
    }
    return true;
  });

  await check('GET /api/admin/reminder-status with WRONG org token -> 404', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/reminder-status?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': 'wrong-org-token-NEVER-valid' } }
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });

  await check('POST /api/admin/send-reminder?type=T-7 -> 200 + { ok, sent, skipped, failed }', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/send-reminder?slug=${encodeURIComponent(SLUG)}&type=T-7`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status} body=${JSON.stringify(json)}`;
    if (!json || json.ok !== true) return 'ok flag missing';
    if (typeof json.sent !== 'number') return `sent not number: ${json.sent}`;
    if (typeof json.skipped !== 'number') return `skipped not number: ${json.skipped}`;
    if (typeof json.failed !== 'number') return `failed not number: ${json.failed}`;
    console.log(`        [info] reminder send result: sent=${json.sent} skipped=${json.skipped} failed=${json.failed} errors=${JSON.stringify(json.errors)}`);
    // After the send, status table should have a row for our participant + T-7
    const { json: statusJson } = await fetchJson(
      `${BASE}/api/admin/reminder-status?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    const row = (statusJson?.status || []).find((r) => r.token === me.token && r.type === 'T-7');
    if (!row) return `no reminders_sent row for token=${me.token} type=T-7`;
    if (!['sent', 'failed', 'skipped_no_email'].includes(row.status)) {
      return `unexpected row.status=${row.status}`;
    }
    return true;
  });

  await check('POST /api/admin/send-reminder with INVALID type -> 400', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/send-reminder?slug=${encodeURIComponent(SLUG)}&type=NOPE`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 400) return `status ${status} expected 400`;
    return true;
  });

  await check('POST /api/admin/clear-reminder -> 200 { ok, cleared:true }', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/clear-reminder?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}&type=T-7`,
      { method: 'POST', headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || json.ok !== true || json.cleared !== true) return `unexpected body: ${JSON.stringify(json)}`;
    return true;
  });

  await check('POST /api/admin/clear-reminder with WRONG org token -> 404', async () => {
    const { status } = await fetchJson(
      `${BASE}/api/admin/clear-reminder?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(me.token)}&type=T-7`,
      { method: 'POST', headers: { 'X-Organizer-Token': 'wrong-org-token-NEVER-valid' } }
    );
    if (status !== 404) return `status ${status} expected 404`;
    return true;
  });
}

const elapsed = ((Date.now() - started) / 1000).toFixed(2);
console.log('\n' + '-'.repeat(60));
console.log(`[smoke] ${pass} passed, ${fail} failed, ${skipped} skipped (${elapsed}s)`);
if (fail > 0) {
  console.error('[smoke] FAIL');
  process.exit(1);
}
console.log('[smoke] PASS');
