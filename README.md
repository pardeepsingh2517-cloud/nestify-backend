# Nestify Pro — Backend Server (Firebase + Razorpay)

## Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** Firebase Firestore (NoSQL, real-time, scalable)
- **Payment:** Razorpay (India)
- **Email:** Nodemailer (Gmail / any SMTP)

---

## Quick Setup (10 minutes)

### Step 1 — Install dependencies
```bash
cd nestify-backend
npm install
cp .env.example .env
```

### Step 2 — Firebase Setup
1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create project → **"Nestify"**
3. Go to **Firestore Database** → Create database (production mode)
4. Go to **Project Settings** → **Service Accounts**
5. Click **"Generate new private key"** → download `serviceAccountKey.json`
6. In `.env`:
   ```
   FIREBASE_PROJECT_ID=your-project-id
   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
   ```
   **OR** paste the JSON content:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
   ```

### Step 3 — Razorpay Setup
1. Create account at [razorpay.com](https://razorpay.com)
2. Go to **Settings** → **API Keys** → Generate key
3. Add to `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_live_xxxxx
   RAZORPAY_KEY_SECRET=your-secret
   ```

### Step 4 — Start Server
```bash
npm start
# Server runs on http://localhost:3001
```

---

## API Reference

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/license/validate` | Validate key in app | Public |
| `GET`  | `/api/license/plans` | Plan info for pricing page | Public |
| `POST` | `/api/payment/create-order` | Create Razorpay order | Public |
| `POST` | `/api/payment/verify` | Verify payment → generate key | Public |
| `POST` | `/api/admin/generate` | Manually create key | Admin |
| `GET`  | `/api/admin/licenses` | List all licenses | Admin |
| `POST` | `/api/admin/revoke` | Revoke a key | Admin |
| `GET`  | `/api/admin/stats` | Dashboard stats | Admin |
| `DELETE`| `/api/admin/activation` | Remove device slot | Admin |
| `GET`  | `/health` | Server health check | Public |

**Admin auth:** `Authorization: Bearer YOUR_ADMIN_TOKEN`

---

## Payment Flow (Razorpay)

```
1. User clicks "Buy Pro" on your website
2. Frontend → POST /api/payment/create-order → gets { orderId, amount, keyId }
3. Frontend opens Razorpay checkout (using their JS SDK)
4. User pays → Razorpay calls your frontend callback
5. Frontend → POST /api/payment/verify → { razorpay_order_id, payment_id, signature }
6. Backend verifies signature → generates key → emails user
7. User enters key in Nestify → validated via /api/license/validate
```

### Frontend Payment Button Example
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
async function buyPlan(plan) {
  // 1. Create order
  const order = await fetch('/api/payment/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, email: 'user@email.com', name: 'User Name' })
  }).then(r => r.json());

  // 2. Open Razorpay
  const rzp = new Razorpay({
    ...order,
    handler: async function(response) {
      // 3. Verify payment
      const result = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response)
      }).then(r => r.json());

      if (result.success) {
        alert('License key sent to your email: ' + result.key);
      }
    }
  });
  rzp.open();
}
</script>

<button onclick="buyPlan('pro')">Buy Pro — ₹1999/mo</button>
```

---

## Firebase Firestore Collections

### `licenses`
```
{
  key: "NESTF-PXXXX-XXXX-XXXX-XXXX",
  plan: "pro",
  email: "user@example.com",
  name: "Ali Khan",
  status: "active",          // active | revoked | expired
  maxMachines: 3,
  expiresAt: null,           // Firestore Timestamp or null
  paymentId: "pay_XXXXXX",   // Razorpay payment ID
  source: "razorpay",        // razorpay | admin
  createdAt: Timestamp
}
```

### `activations`
```
{
  licenseKey: "NESTF-...",
  machineId: "M-XXXXXXXX",
  ip: "103.x.x.x",
  activatedAt: Timestamp,
  lastSeen: Timestamp
}
```

### `orders`
```
{
  orderId: "order_XXXXXX",
  plan: "pro",
  email: "user@example.com",
  amount: 199900,
  status: "paid",           // created | paid
  licenseKey: "NESTF-...",
  paidAt: Timestamp
}
```

---

## Admin CLI

```bash
# Generate key manually
node admin.js generate --plan pro --email user@email.com --name "Ali Khan" --send-email

# List recent licenses
node admin.js list

# Revoke a key
node admin.js revoke --key NESTF-PXXXX-XXXX-XXXX-XXXX --reason "Refund requested"

# Stats
node admin.js stats

# See device activations for a key
node admin.js activations --key NESTF-PXXXX-XXXX-XXXX-XXXX
```

---

## Plans

| Plan | Parts | Sheets | Export | Price |
|------|-------|--------|--------|-------|
| Free | 10 | 1 | ❌ | ₹0 |
| Pro | 999 | 50 | ✅ | ₹1999/mo |
| Enterprise | Unlimited | Unlimited | ✅ | ₹5999/mo |

---

## Deploy to Production

### Railway (Recommended — free tier available)
1. Push code to GitHub
2. Connect Railway to GitHub repo
3. Add all `.env` variables in Railway dashboard
4. Deploy → gets a URL like `nestify-backend.railway.app`

### Render
Same as Railway — free tier, auto-deploy from GitHub.

### VPS (DigitalOcean/AWS/Hostinger)
```bash
npm install -g pm2
pm2 start server.js --name nestify
pm2 save && pm2 startup
```

---

## Connect Frontend to Backend

In `Nestify.html`, change one line:
```js
const API_BASE_URL = 'https://your-backend-url.railway.app';
```
