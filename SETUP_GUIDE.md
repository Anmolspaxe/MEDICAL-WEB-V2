# MediCare Hospital — Production Setup Guide
## Complete Step-by-Step Deployment

---

## What Was Built

| File | Purpose |
|------|---------|
| `backend/api.js` | Node.js/Express backend — JWT auth, bcrypt, 2FA, SMS, email, audit |
| `backend/database_schema.sql` | All Supabase tables + Row Level Security policies |
| `backend/.env.example` | Environment variable template |
| `frontend/login.html` | Secure login with OTP/2FA, DPDPA consent modal |
| `frontend/doctor_availability.html` | Doctor sets weekly hours, views booked slots |
| `frontend/page6_appointment.html` | Smart booking with live availability calendar |
| `frontend/Reception_admin_panel.html` | Reception dashboard with SMS/email + audit trail link |
| `frontend/audit_trail.html` | Tamper-evident audit log viewer with CSV export |

---

## STEP 1 — Supabase Setup (15 minutes)

### 1a. Create a Supabase project
1. Go to **https://supabase.com** → New Project
2. Note your **Project URL** and **Service Role Key** (Settings → API)
3. The **anon key** goes in frontend files only — the **service role key** goes in your backend `.env` only

### 1b. Run the database schema
1. Supabase Dashboard → **SQL Editor** → New Query
2. Paste the entire contents of `backend/database_schema.sql`
3. Click **Run**
4. You should see all tables created: doctors, receptionists, patients, appointments, prescriptions, patient_reports, patient_consents, audit_logs, doctor_availability

### 1c. Enable RLS (already in the SQL, but verify)
1. Supabase Dashboard → Table Editor → each table
2. Confirm the RLS shield icon shows **Enabled**
3. Most important: `appointments`, `patients`, `prescriptions` must all show RLS enabled

### 1d. Create the Storage bucket
1. Supabase Dashboard → **Storage** → Create Bucket
2. Name: `patient-reports`
3. Public: **OFF** (private)
4. File size limit: **20 MB**
5. Allowed MIME types: `image/jpeg,image/png,application/pdf`

---

## STEP 2 — Backend API Setup (20 minutes)

### 2a. Install Node.js
Download from **https://nodejs.org** (v18 or higher recommended)

### 2b. Set up the project
```bash
mkdir medicare-backend
cd medicare-backend
cp /path/to/api.js .
npm init -y
npm install express cors helmet express-rate-limit express-validator \
            morgan dotenv @supabase/supabase-js bcryptjs jsonwebtoken \
            speakeasy qrcode nodemailer twilio
```

### 2c. Create your .env file
```bash
cp .env.example .env
# Open .env and fill in all values (see below)
```

Fill in each value in `.env`:

**JWT_SECRET** — Generate a secure random string:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**SUPABASE_URL** — From Supabase Dashboard → Settings → API

**SUPABASE_SERVICE_ROLE_KEY** — From Supabase Dashboard → Settings → API → service_role key
> ⚠️ This key bypasses RLS. NEVER put it in frontend code. Backend only.

**STAFF_CODE** — Choose a secure code that receptionists enter when registering (e.g. `HOSP2024SEC!`)

### 2d. Set up Twilio (SMS OTP + notifications)
1. Go to **https://twilio.com** → Sign up
2. Dashboard → Account SID + Auth Token → put in `.env`
3. Go to **Verify** → Create Service → copy the Service SID → `TWILIO_VERIFY_SID`
4. Buy a phone number → put in `TWILIO_FROM`
5. In India: use `+91` format; apply for DLT registration for commercial SMS

### 2e. Set up Email (Gmail App Password)
1. Google Account → Security → Enable 2-Step Verification
2. Go to **https://myaccount.google.com/apppasswords**
3. Create an app password for "Mail"
4. Put your Gmail address in `SMTP_USER` and the 16-char password in `SMTP_PASS`

> For production: use a proper transactional email service like **Resend.com** or **Postmark**

### 2f. Start the backend
```bash
node api.js
# Should print: ✅  MediCare API → http://localhost:4000
```

### 2g. Test the API
```bash
curl http://localhost:4000/api/health
# Should return: {"status":"ok","ts":"..."}
```

---

## STEP 3 — Frontend Configuration (10 minutes)

### 3a. Update the API URL in each HTML file
In every frontend file, find this line:
```javascript
const API = 'http://localhost:4000/api';
```
Replace with your deployed backend URL:
```javascript
const API = 'https://api.yourhospital.com/api';
```

### 3b. Update Supabase credentials
In frontend files, the `SUPABASE_ANON_KEY` is the **publishable anon key** — this is safe to keep in frontend code. Update `SUPABASE_URL` to match your project.

### 3c. Remove the fallback flag in login.html
Find and change:
```javascript
const USE_DIRECT_SUPABASE_FALLBACK = true;
```
To:
```javascript
const USE_DIRECT_SUPABASE_FALLBACK = false;
```
> The fallback was only for development without a backend running.

---

## STEP 4 — EmailJS (existing email system, keep for direct sends)

If you want to keep EmailJS for direct appointment confirmations (no backend needed):
1. Go to **https://emailjs.com** → Sign in
2. Services → Add Service → Gmail → note `service_medicare`
3. Email Templates → Create Template → note `template_hiiln3c`
4. Account → Public Key → note `pqsDPUO...`
5. These are already set in the appointment files

---

## STEP 5 — Deploy to Production

### Option A: Deploy backend to Railway (easiest, free tier)
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
# Railway gives you a URL like https://medicare-api.up.railway.app
```

### Option B: Deploy backend to Render.com
1. Push code to GitHub
2. Go to **render.com** → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node api.js`
5. Add all environment variables in the dashboard

### Option C: Deploy to a VPS (full control)
```bash
# On Ubuntu 22 VPS
sudo apt update && sudo apt install nodejs npm nginx certbot
git clone your-repo
cd medicare-backend && npm install
npm install -g pm2
pm2 start api.js --name medicare-api
pm2 startup
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.yourhospital.com
```

### Deploy frontend
The HTML files are static — host on:
- **Netlify**: drag-and-drop the folder, instant HTTPS
- **Vercel**: `vercel deploy`
- **GitHub Pages**: push to a repo, enable Pages
- **Nginx on VPS**: `sudo cp -r frontend/* /var/www/html/`

---

## STEP 6 — Link the New Pages

### Add these links to your existing pages:

**In Reception_admin_panel.html sidebar** (already done in the new version):
```html
<a class="nav-item" href="audit_trail.html">🔍 Audit Trail</a>
```

**In Page8_doctor_dashboard.html sidebar**, add:
```html
<a class="nav-item" href="doctor_availability.html">📆 My Availability</a>
```

**Replace page6_appointment.html** with the new version that shows live availability slots.

**Replace login.html** with the new version that has OTP + consent modal.

---

## STEP 7 — Security Hardening Checklist

Before going live with real patients:

- [ ] JWT_SECRET is at least 64 random bytes — never the default
- [ ] SUPABASE_SERVICE_ROLE_KEY is ONLY in backend .env, never in HTML
- [ ] USE_DIRECT_SUPABASE_FALLBACK = false in login.html
- [ ] RLS is enabled on all sensitive tables (verify in Supabase dashboard)
- [ ] Storage bucket `patient-reports` is set to private (not public)
- [ ] Backend is served over HTTPS (SSL certificate installed)
- [ ] Frontend is served over HTTPS
- [ ] CORS ALLOWED_ORIGIN is set to your exact frontend domain
- [ ] STAFF_CODE has been changed from the default
- [ ] Rate limiter is active (already in api.js — verify in production logs)
- [ ] Audit log table has UPDATE/DELETE revoked (already in schema SQL)
- [ ] Password hashing is bcrypt cost-12 (already in api.js)
- [ ] Patients must accept consent modal before account creation

---

## STEP 8 — Legal & Compliance (India)

### DPDPA 2023 (Digital Personal Data Protection Act)
The consent modal in login.html already captures:
- Explicit consent with version number
- Timestamp and IP address of consent
- Stored in `patient_consents` table

**Additional steps required:**
1. Appoint a **Data Protection Officer (DPO)** — even a part-time one
2. Create a formal **Privacy Policy** page (the consent modal references it)
3. Register under DPDPA if processing sensitive health data of >10,000 persons
4. Add a **data deletion request** form (email: privacy@yourhospital.com)

### ABDM (Ayushman Bharat Digital Mission)
For ABHA ID integration:
1. Register at **https://sandbox.abdm.gov.in**
2. Get your Health Facility Registry (HFR) ID
3. Integrate ABHA (Health ID) creation flow using their SDK

### MCI / NMC Data Retention
Medical records must be retained for **7 years** minimum. The system stores everything in Supabase indefinitely — add a retention policy review reminder to your calendar.

---

## STEP 9 — Payment Gateway (Optional)

For online payments before appointments:

### Razorpay (recommended for India)
```html
<!-- Add to page6_appointment.html before submit -->
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```
```javascript
async function initiatePayment(appointmentId, amount) {
  const options = {
    key: 'rzp_live_YOURKEY',
    amount: amount * 100,  // in paise
    currency: 'INR',
    name: 'MediCare Hospital',
    description: 'Consultation Fee',
    handler: async (response) => {
      // Verify payment on backend, then book appointment
      await fetch(`${API}/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: response.razorpay_payment_id, appointmentId })
      });
    }
  };
  new Razorpay(options).open();
}
```

---

## STEP 10 — Monitoring & Backups

### Free monitoring
- **UptimeRobot**: monitors your API health endpoint every 5 mins, alerts on downtime
- Set up at: https://uptimerobot.com → New Monitor → type `HTTPS` → URL: `https://api.yourhospital.com/api/health`

### Supabase automatic backups
- Free tier: 7-day backups (Point-in-Time Recovery)
- Pro tier ($25/mo): Daily backups + PITR up to 30 days

### Application logs
```bash
# With PM2 on VPS:
pm2 logs medicare-api --lines 100

# View in real time:
pm2 logs medicare-api
```

---

## Quick Reference: New Features Added

| Feature | Where | How It Works |
|---------|-------|-------------|
| **bcrypt passwords** | backend/api.js | Cost-12 hashing on register; compare on login |
| **JWT tokens** | backend/api.js | Signed 8-hour tokens; role-scoped; verified on every API call |
| **SMS OTP (2FA)** | backend/api.js + login.html | Twilio Verify → 6-digit code → pre-auth token exchange |
| **TOTP 2FA** | backend/api.js + login.html | Google Authenticator QR setup |
| **RLS policies** | database_schema.sql | Anon key blocked from all sensitive tables |
| **Audit trail** | backend/api.js + audit_trail.html | Every action logged with actor/IP/timestamp; append-only |
| **DPDPA consent** | login.html | Modal shown to patients; stored in patient_consents table |
| **Doctor availability** | doctor_availability.html | Weekly schedule editor; slots shown on booking page |
| **Live slot calendar** | page6_appointment.html | Fetches booked slots from Supabase; greys out taken times |
| **SMS notifications** | backend/api.js | Twilio message sent on appointment accept/decline |
| **Audit log viewer** | audit_trail.html | Real-time log with filters + CSV export |
| **Rate limiting** | backend/api.js | 10 auth attempts / 15 min; 200 global / 15 min |

---

## Support

If you run into issues:
- **Supabase docs**: https://supabase.com/docs
- **Twilio Verify docs**: https://www.twilio.com/docs/verify
- **EmailJS docs**: https://www.emailjs.com/docs
- **Railway docs**: https://docs.railway.app
- **DPDPA guidance**: https://meity.gov.in/data-protection-framework
