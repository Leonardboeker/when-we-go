# Web Push (#9) — Setup & Status

Push is **off by default** and the whole app behaves exactly as before until you
set the VAPID keys. No errors, no UI prompt when unset.

## What's shipped & verified ✅

- **Service worker** `public/sw.js` — shows a notification on `push`, focuses/
  opens the trip URL on `notificationclick`. (Verified: valid JS, served at `/sw.js`.)
- **Opt-in UI** — a `🔔 Benachrichtigungen aktivieren` button on the per-token
  page that registers the SW, requests permission, subscribes via `PushManager`,
  and POSTs the subscription. (Verified: stays **hidden** when push isn't
  configured; no console errors.)
- **Subscription storage** — `push_subscriptions` table in the Durable Object
  (`addPushSubscription` / `getPushSubscriptions` / `removePushSubscription`),
  included in the DSGVO wipe.
- **Endpoints** — `GET /api/push/key` (returns the VAPID public key or **503**),
  `POST /api/push/subscribe` (stores a subscription or **503**). (Verified: both
  503 with no keys; token-gated.)

## Step 1 — generate VAPID keys

```bash
npx web-push generate-vapid-keys
# → Public Key:  B...   (base64url)
#   Private Key: ...    (base64url)
```

## Step 2 — set the secrets in Cloudflare

In the Worker (`when-we-go-api`) → Settings → Variables & Secrets:

| Secret | Value |
|---|---|
| `WHENWEGO_VAPID_PUBLIC_KEY`  | the Public Key from step 1 |
| `WHENWEGO_VAPID_PRIVATE_KEY` | the Private Key from step 1 |
| `WHENWEGO_VAPID_SUBJECT`     | `mailto:deine@mail.de` (contact for the push service) |

Redeploy. The opt-in button now appears; tapping it subscribes the browser.

## Step 3 — the SEND path (remaining, needs implementation + device test)

Storing subscriptions works. **Sending** a push requires the Web Push crypto
(RFC 8291 payload encryption `aes128gcm` + RFC 8292 VAPID `ES256` JWT) inside
the Worker. This was intentionally **not** shipped unverified — it can't be
tested without real VAPID keys + a real device + a real push-service round-trip,
and shipping unverified crypto risks a silent-failure that looks done.

To finish it:

1. Add `worker/lib/webpush.ts` with a `sendPush(env, subscription, payload)`:
   - Build the VAPID JWT (`{aud: new URL(endpoint).origin, exp: now+12h, sub:
     WHENWEGO_VAPID_SUBJECT}`), sign ES256 with the private key (import as JWK
     P-256 from the public x/y + private d).
   - Encrypt the JSON payload with `aes128gcm` (ECDH against the subscription's
     `p256dh` + `auth`, HKDF → CEK + nonce, AES-128-GCM).
   - `POST endpoint` with `Authorization: vapid t=<jwt>, k=<publicKey>`,
     `Content-Encoding: aes128gcm`, `TTL: 86400`.
   - On 404/410 → `removePushSubscription(endpoint)`.
2. Call it best-effort (via `ctx.waitUntil`) on poll-close in
   `worker/scheduled.ts` + `handlers/admin-close.ts`, fanning out over
   `getPushSubscriptions()` with a `{title, body, url}` payload.
3. **Verify on a real device**: set keys, subscribe in Chrome/Android, trigger
   a close, confirm the notification arrives.

> Tip: a tiny, audited Workers-compatible reference for the crypto is the
> cleanest path; verify against a real subscription before trusting it.
