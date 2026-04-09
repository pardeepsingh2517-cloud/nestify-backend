/**
 * Nestify Pro — Backend Server v2.0
 * Stack: Node.js + Express + Firebase Firestore + Razorpay
 *
 * API Routes:
 *   POST /api/license/validate        App validates key on startup
 *   GET  /api/license/plans           Public plan info for pricing page
 *   POST /api/payment/create-order    Frontend → get Razorpay order
 *   POST /api/payment/verify          Verify payment + auto-generate key + email
 *   POST /api/admin/generate          Admin: manually create key
 *   GET  /api/admin/licenses          Admin: list all licenses
 *   POST /api/admin/revoke            Admin: disable a key
 *   DELETE /api/admin/activation      Admin: remove a machine slot
 *   GET  /api/admin/stats             Admin: dashboard stats
 */

'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const nodemailer= require('nodemailer');
const admin     = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────
function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Deployment: paste JSON as env var
    credential = admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    );
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Local dev: path to serviceAccountKey.json
    credential = admin.credential.applicationDefault();
  } else {
    throw new Error(
      'Firebase credentials missing.\n' +
      'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS in .env'
    );
  }

  admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const fs = admin.firestore();
  fs.settings({ ignoreUndefinedProperties: true });
  console.log('✅ Firebase Firestore ready');
  return fs;
}

let db;
try {
  db = initFirebase();
} catch (err) {
  console.error('❌ Firebase init failed:', err.message);
  process.exit(1);
}

// Firestore collections
const Col = {
  licenses:    () => db.collection('licenses'),
  activations: () => db.collection('activations'),
  orders:      () => db.collection('orders'),
  logs:        () => db.collection('usage_logs'),
};

// ─────────────────────────────────────────────
// RAZORPAY INIT
// ─────────────────────────────────────────────
// Razorpay — optional, only init if keys are present
const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const HMAC_SECRET = process.env.HMAC_SECRET || 'CHANGE-THIS-IN-PRODUCTION';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN  || 'CHANGE-THIS-ADMIN-TOKEN';

// Plans (price in paise: ₹1999 = 199900)
const PLANS = {
  free: {
    name: 'Free', priceINR: 0,
    maxParts: 10, maxSheets: 1, export: false, watermark: true,
  },
  pro: {
    name: 'Pro', priceINR: 199900,
    maxParts: 999, maxSheets: 50, export: true, watermark: false,
  },
  enterprise: {
    name: 'Enterprise', priceINR: 599900,
    maxParts: 9999, maxSheets: 999, export: true, watermark: false,
  },
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Generate a signed license key: NESTF-{P|E|F}{SIG4}-XXXX-XXXX-XXXX */
function generateKey(plan, email) {
  const pc   = { free: 'F', pro: 'P', enterprise: 'E' }[plan] || 'P';
  const rand = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  const sig  = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${pc}:${email.toLowerCase()}:${Date.now()}`)
    .digest('hex').slice(0, 4).toUpperCase();
  return `NESTF-${pc}${sig}-${rand()}-${rand()}-${rand()}`;
}

/** Verify Razorpay payment signature */
function verifyRazorpaySign(orderId, paymentId, sig) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === sig;
}

/** Send license key via email */
async function sendEmail(to, name, key, plan) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email skipped] ${to} → ${key}`);
    return;
  }
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({
    from: process.env.EMAIL_FROM || `Nestify Pro <${process.env.SMTP_USER}>`,
    to,
    subject: `Your Nestify Pro License — ${plan.toUpperCase()} Plan`,
    html: `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;background:#0c0f18;color:#e2e8f0;border-radius:12px;overflow:hidden;">
  <div style="background:#f97316;padding:28px;text-align:center;">
    <h1 style="margin:0;color:white;font-size:26px;font-weight:900;">NEST<span style="color:#1a0a00;">FAB</span> Pro</h1>
  </div>
  <div style="padding:32px;">
    <p>Hello <strong>${name || 'there'}</strong>,</p>
    <p>Thank you for purchasing <strong style="color:#f97316;">Nestify ${plan.charAt(0).toUpperCase()+plan.slice(1)}</strong>.</p>
    <div style="background:#07090e;border:2px solid #f97316;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
      <p style="margin:0 0 6px;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.1em;">Your License Key</p>
      <p style="margin:0;font-size:20px;font-weight:900;color:#f97316;font-family:monospace;letter-spacing:0.08em;">${key}</p>
    </div>
    <p><strong>How to activate:</strong></p>
    <ol style="color:#94a3b8;line-height:1.9;">
      <li>Open Nestify Pro</li>
      <li>Enter the key above on the activation screen</li>
      <li>Click <strong>Activate License</strong></li>
    </ol>
    <p style="font-size:12px;color:#475569;">Questions? Just reply to this email.</p>
  </div>
  <div style="padding:14px;background:#07090e;text-align:center;font-size:11px;color:#334155;">© 2025 Nestify Pro</div>
</div>`,
  });
  console.log(`[Email sent] ${to}`);
}

function logUsage(key, action, ip) {
  Col.logs().add({ key, action, ip, ts: admin.firestore.FieldValue.serverTimestamp() })
    .catch(() => {});
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json());

// CORS — allow all (supports file:// local HTML)
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());

app.use('/api/license', rateLimit({ windowMs: 60000, max: 30 }));
app.use('/api/payment', rateLimit({ windowMs: 60000, max: 20 }));
app.use('/api/admin',   rateLimit({ windowMs: 60000, max: 100 }));

function requireAdmin(req, res, next) {
  const tok = (req.headers['authorization'] || '').replace('Bearer ','') || req.query.token;
  if (tok !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─────────────────────────────────────────────
// LICENSE ROUTES
// ─────────────────────────────────────────────

/**
 * POST /api/license/validate
 * Body: { key, machineId }
 */
app.post('/api/license/validate', async (req, res) => {
  try {
    const { key, machineId } = req.body;
    if (!key) return res.json({ valid: false, message: 'Key required' });

    const cleanKey = key.trim().toUpperCase();
    const snap = await Col.licenses().doc(cleanKey).get();

    if (!snap.exists)
      return res.json({ valid: false, message: 'Invalid license key' });

    const lic = snap.data();

    if (lic.status !== 'active')
      return res.json({ valid: false, message: `License is ${lic.status}` });

    if (lic.expiresAt && lic.expiresAt.toDate() < new Date())
      return res.json({ valid: false, message: 'License expired. Please renew.' });

    // Machine tracking
    if (machineId) {
      const actId  = `${cleanKey}__${machineId}`;
      const actRef = Col.activations().doc(actId);
      const actSnap = await actRef.get();

      if (!actSnap.exists) {
        const existing = await Col.activations()
          .where('licenseKey', '==', cleanKey).count().get();
        if (existing.data().count >= (lic.maxMachines || 3)) {
          return res.json({
            valid: false,
            message: `Device limit (${lic.maxMachines || 3}) reached. Contact support.`,
          });
        }
        await actRef.set({
          licenseKey: cleanKey, machineId,
          ip: req.ip, ua: req.headers['user-agent'] || '',
          activatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSeen:    admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await actRef.update({
          lastSeen: admin.firestore.FieldValue.serverTimestamp(),
          ip: req.ip,
        });
      }
    }

    logUsage(cleanKey, 'validate', req.ip);

    res.json({
      valid:    true,
      plan:     lic.plan,
      planInfo: PLANS[lic.plan] || PLANS.pro,
      email:    lic.email,
      name:     lic.name || '',
      expiresAt: lic.expiresAt ? lic.expiresAt.toDate().toISOString() : null,
      message:  'License valid',
    });
  } catch (err) {
    console.error('[validate]', err.message);
    res.status(500).json({ valid: false, message: 'Server error, try again later.' });
  }
});

/** GET /api/license/plans */
app.get('/api/license/plans', (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id, ...p,
      priceDisplay: id === 'free' ? '₹0' : `₹${(p.priceINR / 100).toLocaleString('en-IN')}/mo`,
    })),
  });
});

// ─────────────────────────────────────────────
// RAZORPAY PAYMENT ROUTES
// ─────────────────────────────────────────────

/**
 * POST /api/payment/create-order
 * Body: { plan, email, name }
 * Returns: { orderId, amount, currency, keyId, ... }
 */
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { plan, email, name } = req.body;
    if (!plan || !email) return res.status(400).json({ error: 'plan and email required' });
    if (!PLANS[plan] || plan === 'free') return res.status(400).json({ error: 'Invalid plan' });
    if (!razorpay) return res.status(503).json({ error: 'Payment not configured yet' });

    const planInfo = PLANS[plan];
    const order = await razorpay.orders.create({
      amount:   planInfo.priceINR,
      currency: 'INR',
      receipt:  `nf_${Date.now()}`,
      notes:    { plan, email, name: name || '' },
    });

    await Col.orders().doc(order.id).set({
      orderId: order.id, plan,
      email: email.toLowerCase(), name: name || '',
      amount: planInfo.priceINR, status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      orderId:  order.id,
      amount:   planInfo.priceINR,
      currency: 'INR',
      keyId:    process.env.RAZORPAY_KEY_ID,
      name:     'Nestify Pro',
      description: `${planInfo.name} Plan — Monthly`,
      prefill:  { name: name || '', email },
      theme:    { color: '#f97316' },
    });
  } catch (err) {
    console.error('[create-order]', err.message);
    res.status(500).json({ error: 'Order creation failed: ' + err.message });
  }
});

/**
 * POST /api/payment/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * → Verifies signature → generates key → emails user → saves to Firestore
 */
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ success: false, error: 'Missing payment fields' });

    // 1. Verify Razorpay signature (security check)
    if (!verifyRazorpaySign(razorpay_order_id, razorpay_payment_id, razorpay_signature))
      return res.status(400).json({ success: false, error: 'Payment signature invalid' });

    // 2. Get order from Firestore
    const orderSnap = await Col.orders().doc(razorpay_order_id).get();
    if (!orderSnap.exists)
      return res.status(404).json({ success: false, error: 'Order not found' });

    const order = orderSnap.data();
    if (order.status === 'paid')
      return res.json({ success: true, message: 'Already processed', key: order.licenseKey });

    // 3. Generate license key
    const key = generateKey(order.plan, order.email);

    // 4. Save license to Firestore
    await Col.licenses().doc(key).set({
      key, plan: order.plan,
      email: order.email, name: order.name || '',
      paymentId: razorpay_payment_id,
      orderId:   razorpay_order_id,
      status:    'active',
      maxMachines: 3,
      expiresAt: null,
      source:    'razorpay',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 5. Mark order as paid
    await Col.orders().doc(razorpay_order_id).update({
      status: 'paid', licenseKey: key,
      paymentId: razorpay_payment_id,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 6. Email the key
    await sendEmail(order.email, order.name, key, order.plan);

    res.json({ success: true, key, plan: order.plan, message: `License emailed to ${order.email}` });
  } catch (err) {
    console.error('[verify]', err.message);
    res.status(500).json({ success: false, error: 'Verification failed: ' + err.message });
  }
});

// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

/** GET /api/admin/licenses */
app.get('/api/admin/licenses', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap = await Col.licenses().orderBy('createdAt', 'desc').limit(limit).get();
    res.json({ licenses: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/admin/stats */
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [total, active, pro, ent, orders] = await Promise.all([
      Col.licenses().count().get(),
      Col.licenses().where('status','==','active').count().get(),
      Col.licenses().where('plan','==','pro').count().get(),
      Col.licenses().where('plan','==','enterprise').count().get(),
      Col.orders().where('status','==','paid').count().get(),
    ]);
    res.json({
      totalLicenses:  total.data().count,
      activeLicenses: active.data().count,
      paidOrders:     orders.data().count,
      byPlan: { pro: pro.data().count, enterprise: ent.data().count },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/admin/generate */
app.post('/api/admin/generate', requireAdmin, async (req, res) => {
  try {
    const { plan, email, name, maxMachines, expiresAt, sendEmail: doEmail } = req.body;
    if (!plan || !email) return res.status(400).json({ error: 'plan + email required' });
    if (!PLANS[plan])   return res.status(400).json({ error: 'Unknown plan: ' + plan });

    const key = generateKey(plan, email);
    await Col.licenses().doc(key).set({
      key, plan, email: email.toLowerCase(), name: name || '',
      status: 'active', maxMachines: maxMachines || 3,
      expiresAt: expiresAt ? admin.firestore.Timestamp.fromDate(new Date(expiresAt)) : null,
      source: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (doEmail) await sendEmail(email, name, key, plan);

    res.json({ success: true, key, plan, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/admin/revoke */
app.post('/api/admin/revoke', requireAdmin, async (req, res) => {
  try {
    const { key, reason } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    await Col.licenses().doc(key.trim().toUpperCase()).update({
      status: 'revoked',
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedReason: reason || 'Admin action',
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/admin/activation */
app.delete('/api/admin/activation', requireAdmin, async (req, res) => {
  try {
    const { key, machineId } = req.body;
    await Col.activations().doc(`${key.toUpperCase()}__${machineId}`).delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// HEALTH & START
// ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', db: 'firebase', payment: 'razorpay' }));
app.get('/', (req, res) => res.json({ service: 'Nestify License API', version: '2.0.0' }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

app.listen(PORT, () => {
  console.log(`\n✅ Nestify Backend  →  http://localhost:${PORT}`);
  console.log(`   DB        : Firebase Firestore (${process.env.FIREBASE_PROJECT_ID || 'project not set'})`);
  console.log(`   Payment   : Razorpay (${process.env.RAZORPAY_KEY_ID ? 'configured ✓' : 'key not set ✗'})`);
  console.log(`   Email     : ${process.env.SMTP_USER || 'not configured (emails will be logged)'}`);
  console.log(`   Admin     : ${ADMIN_TOKEN === 'CHANGE-THIS-ADMIN-TOKEN' ? '⚠️  DEFAULT TOKEN — change in .env!' : 'custom ✓'}\n`);
});

module.exports = app;
