# PrOS Payment Worker (100% Free)

Cloudflare Worker for secure Razorpay payments in PrOS. Runs entirely on the
Cloudflare **free tier** (100,000 requests/day) — no Blaze plan, no paid services.

## Why this design

- Firebase Spark tier cannot run server-side code (Cloud Functions needs Blaze).
- A Cloudflare Worker verifies Razorpay signatures and writes to Firestore via
  the REST API using a free GCP service account — all secret handling stays
  server-side, the client only ever sees the public Razorpay Key ID.
- No Node dependencies in the Worker: pure Web Crypto + `fetch`, so it deploys
  on the free plan with no compatibility flags.

## Setup

### 1. Get your keys
- **Razorpay** (free, test mode): Dashboard → Settings → API Keys → Generate Test Key.
  Copy the Key ID (`rzp_test_...`) and Key Secret.
- **Razorpay webhook secret**: Dashboard → Webhooks → add webhook (below) → copy the secret.
- **Firebase service account**: Firebase Console → Project Settings → Service Accounts →
  Generate new private key. Download the JSON.

### 2. Install & log in
```bash
cd cloudflare-worker
npm install
npx wrangler login
```

### 3. Set secrets (never commit these)
```bash
npx wrangler secret put FIREBASE_PROJECT_ID       # pros-84fe4
npx wrangler secret put FIRESTORE_SERVICE_ACCOUNT  # paste full service-account JSON
npx wrangler secret put RAZORPAY_KEY_ID            # rzp_test_...
npx wrangler secret put RAZORPAY_KEY_SECRET        # test key secret
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET    # webhook secret
```
Prices are in `wrangler.toml` (`PLANS_JSON`, amounts in paise). Edit there.

### 4. Deploy
```bash
npx wrangler deploy
```
Copy the deployed URL, e.g. `https://pros-payment-worker.<your-subdomain>.workers.dev`.

### 5. Connect the app
In `index.html`, set:
```js
window.PAYMENT_WORKER_URL = 'https://pros-payment-worker.<your-subdomain>.workers.dev';
window.RAZORPAY_KEY_ID    = 'rzp_test_YOUR_KEY_ID';
```

### 6. Configure Firestore rules
Allow each signed-in user to read their own subscription (the Worker writes with
service-account privileges, so no client write rule is needed):
```
match /users/{uid}/subscription/{doc} {
  allow read: if request.auth != null && request.auth.uid == uid;
}
```

### 7. Configure the Razorpay webhook
Dashboard → Webhooks → Add:
- **URL**: `https://pros-payment-worker.<your-subdomain>.workers.dev/webhook/razorpay`
- **Events**: `payment.captured`, `payment.failed`, `payment.refunded`
- **Secret**: same value as `RAZORPAY_WEBHOOK_SECRET`

## API

| Endpoint | Auth | Body | Purpose |
|---|---|---|---|
| `GET /` | none | — | Health check |
| `POST /api/create-order` | Firebase ID token | `{ planId, uid }` | Create Razorpay order |
| `POST /api/verify-payment` | Firebase ID token | `{ razorpayOrderId, razorpayPaymentId, razorpaySignature, planId, uid }` | Verify signature + activate subscription |
| `POST /webhook/razorpay` | Razorpay HMAC | Razorpay event | Idempotent subscription updates |

Subscription is stored at `users/{uid}/subscription/current` with
`{ status: 'active', plan, planId, isLifetime, renewsAt, ... }`.

## Test
Use Razorpay test key + test card `4111 1111 1111 1111` (any CVV/expiry).
`npx wrangler tail` shows live logs while testing.
