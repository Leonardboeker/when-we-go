// worker/lib/webpush.ts
// #9 — Web Push send (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID
// ES256 JWT auth), implemented on the Web Crypto API so it runs unchanged in a
// Cloudflare Worker AND Node 22 (which is how the round-trip test verifies it).
//
// Public: sendPush(env, subscription, payload) — best-effort, never throws into
// the caller (returns { ok, status, skipped?, error? }). Skips when VAPID keys
// are unset.

interface VapidEnv {
  WHENWEGO_VAPID_PUBLIC_KEY?: string;
  WHENWEGO_VAPID_PRIVATE_KEY?: string;
  WHENWEGO_VAPID_SUBJECT?: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

// ── base64url helpers ──────────────────────────────────────────────────────
export function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────
async function importVapidSigningKey(publicB64: string, privateB64: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicB64); // 65 bytes: 0x04 || x(32) || y(32)
  const priv = b64urlToBytes(privateB64); // 32 bytes d
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(priv),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function buildVapidJwt(
  endpoint: string,
  publicB64: string,
  privateB64: string,
  subject: string,
  nowSec: number
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const enc = new TextEncoder();
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(
    enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 60 * 60, sub: subject }))
  );
  const signingInput = header + '.' + payload;
  const key = await importVapidSigningKey(publicB64, privateB64);
  // WebCrypto ECDSA → IEEE P1363 raw r||s, which is exactly the JOSE format.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput))
  );
  return signingInput + '.' + bytesToB64url(sig);
}

// ── aes128gcm payload encryption (RFC 8291 / RFC 8188) ──────────────────────
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    len * 8
  );
  return new Uint8Array(bits);
}

export async function encryptAes128gcm(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authB64: string,
  // Injectable for deterministic tests; production uses random.
  testSalt?: Uint8Array,
  testAsKeys?: CryptoKeyPair
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(uaPublicB64); // 65 bytes
  const authSecret = b64urlToBytes(authB64); // 16 bytes
  const asKeys =
    testAsKeys ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, asKeys.privateKey, 256)
  ); // 32 bytes
  const salt = testSalt ?? crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();

  // PRK / IKM: HKDF(auth, ecdh, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // plaintext || 0x02 (last-record delimiter, no further padding)
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded)
  );

  // header: salt(16) || rs(4 BE) || idlen(1) || keyid=as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ct);
}

export async function sendPush(
  env: VapidEnv,
  subscription: PushSubscriptionJSON | string,
  payload: PushPayload
): Promise<{ ok: boolean; status?: number; skipped?: boolean; error?: string }> {
  if (!env.WHENWEGO_VAPID_PUBLIC_KEY || !env.WHENWEGO_VAPID_PRIVATE_KEY) {
    return { ok: false, skipped: true };
  }
  try {
    const sub: PushSubscriptionJSON =
      typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return { ok: false, error: 'bad subscription' };
    }
    const body = await encryptAes128gcm(
      new TextEncoder().encode(JSON.stringify(payload)),
      sub.keys.p256dh,
      sub.keys.auth
    );
    const jwt = await buildVapidJwt(
      sub.endpoint,
      env.WHENWEGO_VAPID_PUBLIC_KEY,
      env.WHENWEGO_VAPID_PRIVATE_KEY,
      env.WHENWEGO_VAPID_SUBJECT || 'mailto:admin@when-we-go.app',
      Math.floor(Date.now() / 1000)
    );
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'vapid t=' + jwt + ', k=' + env.WHENWEGO_VAPID_PUBLIC_KEY,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
      },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
