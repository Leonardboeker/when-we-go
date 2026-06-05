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

## Step 3 — the SEND path ✅ implemented & crypto-verified

`worker/lib/webpush.ts` implements `sendPush(env, subscription, payload)`:
- VAPID `ES256` JWT (`{aud: endpoint origin, exp: now+12h, sub: VAPID_SUBJECT}`),
  signed with the private key.
- `aes128gcm` payload encryption (ECDH vs the subscription's `p256dh` + `auth`,
  HKDF → CEK + nonce, AES-128-GCM, RFC 8291).
- `POST endpoint` with `Authorization: vapid t=<jwt>, k=<publicKey>`,
  `Content-Encoding: aes128gcm`, `TTL: 86400`. Dead endpoints (404/410) are
  pruned via `removePushSubscription`.

It's wired best-effort (via `ctx.waitUntil`) on poll-close in both
`handlers/admin-close.ts` and `worker/scheduled.ts`, fanning out over
`getPushSubscriptions()` with a "🎉 Termin steht" payload.

**Verified:** `worker/lib/webpush.test.ts` (in CI as `npm run test:webpush`)
checks the crypto in isolation — the `aes128gcm` payload **encrypt → decrypt
round-trips**, and the VAPID JWT **verifies against the public key** with the
correct `aud`/`sub`/`exp`. That's the same work a real push service does, so a
spec-correct round-trip means the send is sound.

### Last mile — real-device confirmation

The only thing a local test can't exercise is the live HTTP POST to a real push
service. After setting the keys (steps 1–2): open a per-token page in Chrome,
tap `🔔 Benachrichtigungen aktivieren`, then close the poll from the admin
dashboard and confirm the notification arrives. (If it doesn't, check the Worker
logs for the push-service response status.)
