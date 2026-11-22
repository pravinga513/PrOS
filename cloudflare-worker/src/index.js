/**
 * PrOS Payment Worker — Cloudflare Worker (FREE tier)
 *
 * Handles Razorpay payment processing for PrOS.
 * All sensitive operations (signature verification, Firestore writes) happen
 * here. No secrets are ever exposed in the client bundle.
 *
 * Uses only Web Crypto + fetch — no Node.js dependencies, so it runs on the
 * free Workers plan with no compatibility flags.
 */

/* ============================================================
   BASE64URL HELPERS (JWT + Razorpay signatures use base64url)
   ============================================================ */
function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
function bytesToBase64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return base64urlEncode(s);
}

/* ============================================================
   FIRESTORE REST CLIENT (no Admin SDK — pure REST via fetch)
   ============================================================ */

/** Get a Google OAuth2 access token for the Firestore REST API. */
async function getFirestoreToken(serviceAccountKey) {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: serviceAccountKey.client_email,
    sub: serviceAccountKey.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600
  };

  const encoder = new TextEncoder();
  const headerB64 = base64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));

  const keyData = pemToArrayBuffer(serviceAccountKey.private_key);
  const key = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  const assertion = `${headerB64}.${payloadB64}.${bytesToBase64url(new Uint8Array(signature))}`;

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

/** Convert a PEM private key to an ArrayBuffer for Web Crypto. */
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Write a document to Firestore via REST API (supports nested paths). */
async function firestoreSet(token, projectId, path, docId, data) {
  const fields = Object.keys(data)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}/${docId}?${fields}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Read a document from Firestore via REST API. Returns null if missing. */
async function firestoreGet(token, projectId, path, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}/${docId}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed: ${res.status}`);
  return res.json();
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) fields[key] = toFirestoreValue(value);
  return fields;
}
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') return { mapValue: { fields: toFirestoreFields(val) } };
  return { stringValue: String(val) };
}
function fromFirestoreFormat(doc) {
  if (!doc || !doc.fields) return null;
  const obj = {};
  for (const [key, val] of Object.entries(doc.fields)) obj[key] = fromFirestoreValue(val);
  return obj;
}
function fromFirestoreValue(val) {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue, 10);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.timestampValue !== undefined) return val.timestampValue;
  if (val.arrayValue) return (val.arrayValue.values || []).map(fromFirestoreValue);
  if (val.mapValue) return fromFirestoreFormat({ fields: val.mapValue.fields });
  return null;
}

/** Subscription document path — must match the client: users/{uid}/subscription/current */
function subscriptionPath(uid) { return `users/${uid}/subscription`; }

/* ============================================================
   RAZORPAY REST API (no SDK — plain fetch)
   ============================================================ */
async function razorpayCreateOrder(env, plan) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: plan.amount,
      currency: 'INR',
      notes: { planId: plan.id }
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error('Razorpay order failed: ' + JSON.stringify(data));
  return data;
}

/* ============================================================
   SIGNATURE VERIFICATION (Web Crypto, base64url hex-safe)
   ============================================================ */
async function verifyPaymentSignature(orderId, paymentId, signature, keySecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(keySecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(`${orderId}|${paymentId}`));
}

async function verifyWebhookSignature(body, signature, webhookSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
}

/* ============================================================
   FIREBASE ID TOKEN VERIFICATION (RS256, base64url-safe)
   ============================================================ */
async function verifyIdToken(idToken, env) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');

  // base64url decode — plain atob() fails on '-' and '_'
  const header = JSON.parse(base64urlDecode(parts[0]));
  const payload = JSON.parse(base64urlDecode(parts[1]));

  if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error('Invalid issuer');
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error('Invalid audience');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

  const keysRes = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!keysRes.ok) throw new Error('Failed to fetch Google public keys');
  const keys = await keysRes.json();
  const cert = keys[header.kid];
  if (!cert) throw new Error('Unknown key ID');

  const b64 = cert.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s/g, '');
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);

  const key = await crypto.subtle.importKey('spki', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(base64urlDecode(parts[2]), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('Invalid token signature');
  return payload;
}

async function requireAuth(request, env, expectedUid) {
  const header = request.headers.get('Authorization') || '';
  const idToken = header.replace(/^Bearer\s+/i, '');
  if (!idToken) throw new Error('Missing auth token');
  const decoded = await verifyIdToken(idToken, env);
  if (decoded.uid !== expectedUid) throw new Error('UID mismatch');
  return decoded;
}

/* ============================================================
   SUBSCRIPTION ACTIVATION (shared by verify + webhook)
   ============================================================ */
function buildSubscription(plan, payment) {
  const now = new Date();
  let renewsAt = null;
  if (plan.interval === 'monthly') { const d = new Date(now); d.setMonth(d.getMonth() + 1); renewsAt = d; }
  else if (plan.interval === 'yearly') { const d = new Date(now); d.setFullYear(d.getFullYear() + 1); renewsAt = d; }
  return {
    status: 'active',
    plan: plan.id,
    planId: plan.id,
    isLifetime: plan.interval === 'lifetime',
    renewsAt,
    paymentId: payment.id || null,
    orderId: payment.order_id || null,
    updatedAt: now
  };
}

/* ============================================================
   ROUTE HANDLERS
   ============================================================ */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function getPlans(env) {
  try { return JSON.parse(env.PLANS_JSON); }
  catch { return {
    pro_monthly: { id: 'pro_monthly', amount: 4900, interval: 'monthly', name: 'Pro Monthly' },
    pro_yearly: { id: 'pro_yearly', amount: 49900, interval: 'yearly', name: 'Pro Yearly' },
    lifetime: { id: 'lifetime', amount: 249900, interval: 'lifetime', name: 'Lifetime' }
  }; }
}

/** GET / → health check */
function handleHealth() {
  return json({ status: 'ok', service: 'pros-payment-worker', version: '2.0.0' });
}

/** POST /api/create-order — body: { planId, uid } + Bearer auth */
async function handleCreateOrder(request, env) {
  const { planId, uid } = await request.json();
  if (!planId || !uid) return json({ error: 'planId and uid required' }, 400);
  await requireAuth(request, env, uid);

  const plans = getPlans(env);
  const plan = plans[planId];
  if (!plan) return json({ error: 'Invalid planId' }, 400);

  const order = await razorpayCreateOrder(env, plan);
  return json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency || 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    planName: plan.name || planId
  });
}

/** POST /api/verify-payment — body: { razorpayOrderId, razorpayPaymentId, razorpaySignature, planId, uid } */
async function handleVerifyPayment(request, env) {
  const body = await request.json();
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, planId, uid } = body;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !planId || !uid) {
    return json({ error: 'Missing payment verification params' }, 400);
  }
  await requireAuth(request, env, uid);

  const valid = await verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature, env.RAZORPAY_KEY_SECRET);
  if (!valid) return json({ error: 'Invalid signature' }, 400);

  const plans = getPlans(env);
  const plan = plans[planId];
  if (!plan) return json({ error: 'Invalid planId' }, 400);

  const token = await getFirestoreToken(env.FIRESTORE_SERVICE_ACCOUNT);
  const subPath = subscriptionPath(uid);

  // Idempotency
  const existing = await firestoreGet(token, env.FIREBASE_PROJECT_ID, subPath, 'current');
  const current = existing ? fromFirestoreFormat(existing) : null;
  if (current && current.paymentId === razorpayPaymentId) {
    return json({ status: 'already_processed', subscription: current });
  }

  const subscription = buildSubscription(plan, { id: razorpayPaymentId, order_id: razorpayOrderId });
  await firestoreSet(token, env.FIREBASE_PROJECT_ID, subPath, 'current', subscription);
  await firestoreSet(token, env.FIREBASE_PROJECT_ID, 'payments', `${uid}_${razorpayPaymentId}`, {
    uid, planId, amount: plan.amount, currency: 'INR', status: 'captured', createdAt: new Date()
  });

  return json({ status: 'success', subscription, message: plan.interval === 'lifetime' ? 'Lifetime activated!' : 'Subscription activated!' });
}

/** POST /webhook/razorpay — server-to-server, verified by HMAC */
async function handleWebhook(request, env) {
  const signature = request.headers.get('X-Razorpay-Signature') || '';
  if (!signature) return json({ error: 'Missing signature' }, 400);
  const body = await request.text();
  if (!await verifyWebhookSignature(body, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    return json({ error: 'Invalid webhook signature' }, 400);
  }

  const event = JSON.parse(body);
  const type = event.event;
  const entity = event.payload?.payment?.entity;
  const uid = entity?.notes?.uid;
  const plans = getPlans(env);

  if (type === 'payment.captured' && uid) {
    const token = await getFirestoreToken(env.FIRESTORE_SERVICE_ACCOUNT);
    const subPath = subscriptionPath(uid);
    const existingDoc = await firestoreGet(token, env.FIREBASE_PROJECT_ID, subPath, 'current');
    const current = existingDoc ? fromFirestoreFormat(existingDoc) : null;
    if (!current || current.paymentId !== entity.id) {
      const plan = plans[entity.notes?.planId] || plans.pro_monthly;
      const subscription = buildSubscription(plan, entity);
      await firestoreSet(token, env.FIREBASE_PROJECT_ID, subPath, 'current', subscription);
      await firestoreSet(token, env.FIREBASE_PROJECT_ID, 'payments', `${uid}_${entity.id}`, {
        uid, planId: plan.id, amount: entity.amount, currency: entity.currency, status: 'captured', createdAt: new Date()
      });
    }
    return json({ status: 'ok' });
  }

  if (type === 'payment.failed' && uid && entity) {
    const token = await getFirestoreToken(env.FIRESTORE_SERVICE_ACCOUNT);
    await firestoreSet(token, env.FIREBASE_PROJECT_ID, 'payments', `${uid}_${entity.id}`, {
      uid, amount: entity.amount, currency: entity.currency, status: 'failed',
      errorCode: entity.error_code || null, createdAt: new Date()
    });
    return json({ status: 'ok' });
  }

  if (type === 'payment.refunded' && uid && entity) {
    const token = await getFirestoreToken(env.FIRESTORE_SERVICE_ACCOUNT);
    const subPath = subscriptionPath(uid);
    await firestoreSet(token, env.FIREBASE_PROJECT_ID, 'payments', `${uid}_${entity.id}`, { uid, status: 'refunded', createdAt: new Date() });
    const doc = await firestoreGet(token, env.FIREBASE_PROJECT_ID, subPath, 'current');
    if (doc) {
      const sub = fromFirestoreFormat(doc);
      await firestoreSet(token, env.FIREBASE_PROJECT_ID, subPath, 'current', { ...sub, status: 'refunded', updatedAt: new Date() });
    }
    return json({ status: 'ok' });
  }

  return json({ status: 'ignored', reason: `unhandled event: ${type}` });
}

/* ============================================================
   MAIN ENTRY POINT
   ============================================================ */
function withCors(res) {
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', '*');
  out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  out.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Razorpay-Signature');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Razorpay-Signature'
      }});
    }

    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return handleHealth();
      if (method === 'POST' && url.pathname === '/api/create-order') return withCors(await handleCreateOrder(request, env));
      if (method === 'POST' && url.pathname === '/api/verify-payment') return withCors(await handleVerifyPayment(request, env));
      if (method === 'POST' && url.pathname === '/webhook/razorpay') return await handleWebhook(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  }
};
