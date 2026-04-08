#!/usr/bin/env node
/**
 * Nestify Admin CLI — Firebase edition
 *
 * Commands:
 *   node admin.js generate --plan pro --email user@email.com [--name "Ali"] [--email-key]
 *   node admin.js list
 *   node admin.js revoke --key NESTF-XXXX-XXXX-XXXX-XXXX
 *   node admin.js stats
 *   node admin.js activations --key NESTF-XXXX-...
 */

'use strict';
require('dotenv').config();

const crypto  = require('crypto');
const admin   = require('firebase-admin');
const nodemailer = require('nodemailer');

// Firebase init
function initDb() {
  if (admin.apps.length) return admin.firestore();
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else {
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
  return admin.firestore();
}

const db  = initDb();
const COL = {
  licenses:    db.collection('licenses'),
  activations: db.collection('activations'),
};

const HMAC_SECRET = process.env.HMAC_SECRET || 'CHANGE-THIS-IN-PRODUCTION';

const PLANS = {
  free:       { name: 'Free',       maxParts: 10 },
  pro:        { name: 'Pro',        maxParts: 999 },
  enterprise: { name: 'Enterprise', maxParts: 9999 },
};

function generateKey(plan, email) {
  const pc   = { free: 'F', pro: 'P', enterprise: 'E' }[plan] || 'P';
  const rand = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  const sig  = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${pc}:${email.toLowerCase()}:${Date.now()}`)
    .digest('hex').slice(0, 4).toUpperCase();
  return `NESTF-${pc}${sig}-${rand()}-${rand()}-${rand()}`;
}

async function sendEmail(to, name, key, plan) {
  if (!process.env.SMTP_USER) { console.log('SMTP not configured, skipping email'); return; }
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `Your Nestify Pro License — ${plan.toUpperCase()}`,
    text: `Hello ${name || 'there'},\n\nYour Nestify ${plan} license key:\n\n${key}\n\nActivate at: https://yourdomain.com\n\nThanks!`,
  });
  console.log(`📧 Email sent to ${to}`);
}

// Parse CLI args
const args = process.argv.slice(2);
const cmd  = args[0];
const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const has  = (f) => args.includes(f);

(async () => {
  try {
    if (cmd === 'generate') {
      const plan  = get('--plan')  || 'pro';
      const email = get('--email') || '';
      const name  = get('--name')  || '';
      const exp   = get('--expires');
      if (!email) { console.error('❌ --email required'); process.exit(1); }
      if (!PLANS[plan]) { console.error('❌ Invalid plan:', plan); process.exit(1); }

      const key = generateKey(plan, email);
      await COL.licenses.doc(key).set({
        key, plan, email: email.toLowerCase(), name,
        status: 'active', maxMachines: parseInt(get('--machines')) || 3,
        expiresAt: exp ? admin.firestore.Timestamp.fromDate(new Date(exp)) : null,
        source: 'admin-cli',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log('\n✅ License Generated:');
      console.log(`   Key:   \x1b[33m${key}\x1b[0m`);
      console.log(`   Plan:  ${plan} (${PLANS[plan].name})`);
      console.log(`   Email: ${email}`);
      if (exp) console.log(`   Expires: ${exp}`);

      if (has('--send-email')) await sendEmail(email, name, key, plan);

    } else if (cmd === 'list') {
      const snap = await COL.licenses.orderBy('createdAt', 'desc').limit(30).get();
      if (snap.empty) { console.log('No licenses yet.'); process.exit(0); }
      console.log(`\n📋 Licenses (${snap.size}):\n`);
      console.log('  KEY                          PLAN        STATUS   EMAIL');
      console.log('  ' + '─'.repeat(72));
      snap.forEach(d => {
        const l = d.data();
        console.log(`  ${l.key}  ${(l.plan||'').padEnd(10)}  ${(l.status||'').padEnd(8)} ${l.email}`);
      });

    } else if (cmd === 'revoke') {
      const key = get('--key');
      if (!key) { console.error('❌ --key required'); process.exit(1); }
      await COL.licenses.doc(key.trim().toUpperCase()).update({
        status: 'revoked',
        revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        revokedReason: get('--reason') || 'Admin CLI',
      });
      console.log('✅ Revoked:', key);

    } else if (cmd === 'stats') {
      const [total, active, pro, ent] = await Promise.all([
        COL.licenses.count().get(),
        COL.licenses.where('status','==','active').count().get(),
        COL.licenses.where('plan','==','pro').count().get(),
        COL.licenses.where('plan','==','enterprise').count().get(),
      ]);
      console.log('\n📊 Nestify License Stats');
      console.log('   Total:      ', total.data().count);
      console.log('   Active:     ', active.data().count);
      console.log('   Pro:        ', pro.data().count);
      console.log('   Enterprise: ', ent.data().count);

    } else if (cmd === 'activations') {
      const key = get('--key');
      if (!key) { console.error('❌ --key required'); process.exit(1); }
      const snap = await COL.activations.where('licenseKey','==',key.toUpperCase()).get();
      console.log(`\n🖥️  Activations for ${key}: ${snap.size}`);
      snap.forEach(d => {
        const a = d.data();
        console.log(`   ${a.machineId}  IP:${a.ip}  Last:${a.lastSeen?.toDate?.()?.toLocaleDateString?.() || 'N/A'}`);
      });

    } else {
      console.log(`
Nestify Admin CLI (Firebase)

  Generate key:
    node admin.js generate --plan pro --email user@example.com [--name "Ali"] [--send-email]

  List licenses:
    node admin.js list

  Revoke key:
    node admin.js revoke --key NESTF-XXXX-XXXX-XXXX-XXXX [--reason "Refund"]

  Stats:
    node admin.js stats

  Activations for a key:
    node admin.js activations --key NESTF-XXXX-XXXX-XXXX-XXXX

Plans: free | pro | enterprise
      `);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
  process.exit(0);
})();
