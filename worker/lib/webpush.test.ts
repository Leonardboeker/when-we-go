// worker/lib/webpush.test.ts
// #9 — verifies the Web Push crypto in isolation (no network, no real device):
//  1. aes128gcm encrypt → independent decrypt round-trips the plaintext.
//  2. VAPID ES256 JWT verifies against the public key + has the right claims.
// Run: node --test worker/lib/webpush.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAes128gcm,
  buildVapidJwt,
  b64urlToBytes,
  bytesToB64url,
} from './webpush.ts';

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

test('aes128gcm encrypt → decrypt round-trips the plaintext', async () => {
  // The "browser" (UA) ECDH keypair + auth secret.
  const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const uaPublicB64 = bytesToB64url(uaPublic);
  const authB64 = bytesToB64url(auth);

  // Deterministic sender key + salt so the test is stable.
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const plaintext = new TextEncoder().encode(JSON.stringify({ title: 'Test', body: 'Hallo Welt', url: '/x' }));
  const out = await encryptAes128gcm(plaintext, uaPublicB64, authB64, salt, asKeys);

  // ── Independent decrypt (mirrors a push service / browser) ──
  const hdrSalt = out.slice(0, 16);
  const idlen = out[20];
  const asPublic = out.slice(21, 21 + idlen); // sender public key
  const ciphertext = out.slice(21 + idlen);

  const asPubKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaKeys.privateKey, 256));

  const enc = new TextEncoder();
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const cek = await hkdf(hdrSalt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(hdrSalt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cekKey, ciphertext));
  // Strip the 0x02 delimiter byte.
  assert.equal(decrypted[decrypted.length - 1], 0x02);
  const recovered = decrypted.slice(0, decrypted.length - 1);
  assert.deepEqual([...recovered], [...plaintext]);
});

test('VAPID ES256 JWT verifies against the public key with correct claims', async () => {
  // Generate a VAPID keypair and serialise to the base64url shapes web-push uses.
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); // 65 bytes
  const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicB64 = bytesToB64url(rawPub);
  const privateB64 = jwkPriv.d as string; // already base64url (32-byte d)

  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const nowSec = 1_780_000_000;
  const jwt = await buildVapidJwt(endpoint, publicB64, privateB64, 'mailto:test@x.de', nowSec);

  const [h, p, s] = jwt.split('.');
  // Verify signature against the public key.
  const verifyKey = await crypto.subtle.importKey('raw', rawPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    b64urlToBytes(s),
    new TextEncoder().encode(h + '.' + p)
  );
  assert.equal(ok, true, 'JWT signature must verify');

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:test@x.de');
  assert.equal(payload.exp, nowSec + 12 * 60 * 60);
});
