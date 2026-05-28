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

const started = Date.now();
console.log(`\n[smoke] BASE=${BASE} SLUG=${SLUG}`);
console.log(`[smoke] participants: ${PARTICIPANTS.length || 'NONE (set SMOKE_TOKENS)'}`);
console.log(`[smoke] org token: ${ORG_TOKEN ? 'present' : 'MISSING (set SMOKE_ORGANIZER_TOKEN)'}`);
console.log('');

// (1) Health
console.log('(1) Health:');
await check('GET /api/health -> 200 { ok:true, phase:2 }', async () => {
  const { status, json } = await fetchJson(`${BASE}/api/health`);
  if (status !== 200) return `status ${status}`;
  if (!json || json.ok !== true) return 'ok flag missing';
  if (json.phase !== 2) return `phase=${json.phase} expected 2`;
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

// (3) Admin flow
console.log('\n(3) Admin flow:');
if (!ORG_TOKEN) {
  await check('GET /api/admin/poll', async () => ({ skip: 'no SMOKE_ORGANIZER_TOKEN' }));
} else {
  await check('GET /api/admin/poll with org token -> 200 + voterStatus + overlap', async () => {
    const { status, json } = await fetchJson(
      `${BASE}/api/admin/poll?slug=${encodeURIComponent(SLUG)}`,
      { headers: { 'X-Organizer-Token': ORG_TOKEN } }
    );
    if (status !== 200) return `status ${status}`;
    if (!json || !Array.isArray(json.voterStatus)) return 'voterStatus missing';
    if (!json.overlap || !json.overlap.perDate) return 'overlap missing';
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

const elapsed = ((Date.now() - started) / 1000).toFixed(2);
console.log('\n' + '-'.repeat(60));
console.log(`[smoke] ${pass} passed, ${fail} failed, ${skipped} skipped (${elapsed}s)`);
if (fail > 0) {
  console.error('[smoke] FAIL');
  process.exit(1);
}
console.log('[smoke] PASS');
