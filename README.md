# MediCare Hospital — Production Web App

A **complete, enterprise-grade hospital management system** with JWT authentication, bcrypt password hashing, SMS/email 2FA, audit logging, Row Level Security, Razorpay payments, appointment reminders, DPDPA 2023 compliance, and a full React-less frontend built in plain HTML/CSS/JS.

---

## 📁 Complete File Map (32 files)

### Frontend — `/frontend/` (18 files)

| File | Role | Auth Required |
|------|------|--------------|
| `login.html` | Unified login — JWT + OTP + TOTP + DPDPA consent | Public |
| `forgot_password.html` | Email OTP password reset for all roles | Public |
| `privacy_policy.html` | DPDPA 2023 compliant privacy policy | Public |
| `page6_appointment.html` | Book appointment with live availability slots | Public |
| `payment_booking.html` | Pay consultation fee via Razorpay then book | Public |
| `page7_doctor_portal.html` | Doctor register/login with TOTP setup | Public |
| `Page8_doctor_dashboard.html` | Doctor appointments, prescriptions, availability | Doctor |
| `doctor_availability.html` | Doctor sets weekly working hours + slot checker | Doctor |
| `page9_reports.html` | Upload/view patient reports (PDF/image) | Doctor/Reception |
| `page10_patient_portal.html` | Patient appointments, reports, prescriptions | Patient |
| `Reception_admin_panel.html` | Appointment management, slot assignment, SMS | Receptionist |
| `admin_users.html` | View/activate/deactivate all users | Receptionist |
| `audit_trail.html` | Tamper-evident audit log with CSV export | Receptionist |
| `notification_log.html` | Every SMS and email sent, filterable | Receptionist |
| `system_health.html` | Live service status, DB table counts, manual tests | Staff |
| `deployment_checklist.html` | Interactive pre-launch checklist with progress | Staff |

### Backend — `/backend/` (11 files)

| File | Purpose |
|------|---------|
| `api.js` | Main Express server — all API routes |
| `middleware.js` | Auth, rate limiting, audit, validation helpers |
| `payments.js` | Razorpay order creation, webhook, refunds |
| `msg91.js` | MSG91 SMS (Indian alternative to Twilio) |
| `reminder.js` | Daily cron job — SMS + email day-before reminders |
| `check-env.js` | Validates all env vars before server start |
| `api.test.js` | Jest test suite for every endpoint |
| `database_schema.sql` | Full Supabase schema — tables, RLS, indexes |
| `migration_v2.sql` | Adds payment, SMS, reminder, notification log columns |
| `package.json` | Dependencies, scripts, Jest config |
| `.env.example` | Template for all environment variables |

### Root (3 files)

| File | Purpose |
|------|---------|
| `README.md` | This file |
| `SETUP_GUIDE.md` | Detailed 10-step deployment guide |

---

## 🚀 Quick Start (5 minutes)

```bash
# 1. Install dependencies
cd backend && npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET at minimum

# 3. Generate JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 4. Run database schema
# Paste database_schema.sql into Supabase Dashboard → SQL Editor → Run
# Then paste migration_v2.sql to add payment and reminder columns

# 5. Verify environment
node check-env.js

# 6. Start the API server
node api.js
# → ✅  MediCare API running on http://localhost:4000

# 7. Open any frontend HTML file in a browser
# The API URL defaults to http://localhost:4000/api in each file
```

---

## 🔐 Security Architecture

### Authentication Flow
```
User enters credentials
        ↓
POST /api/auth/login  (bcrypt.compare, cost-12)
        ↓
Phone on file? → Send SMS OTP (Twilio/MSG91) → pre-auth JWT (10 min)
        ↓
POST /api/auth/verify-otp → full JWT (8 hours)
        ↓
Optional: TOTP setup (Google Authenticator)
        ↓
All subsequent requests: Authorization: Bearer <jwt>
```

### Role Permissions

| Resource | Patient | Doctor | Receptionist |
|----------|---------|--------|--------------|
| Own appointments | R | R | R/W |
| All appointments | ✗ | Own only | R/W |
| Prescriptions | Own only | R/W | ✗ |
| Reports | Own only | R/W | R/W |
| User management | ✗ | ✗ | R/W |
| Audit log | ✗ | ✗ | R |
| Availability | ✗ | R/W | R |

### Database Security
- **RLS enabled** on all sensitive tables — anon key blocked from patients/appointments/prescriptions
- **Audit logs are append-only** — UPDATE/DELETE revoked at DB level
- **Notification logs are append-only** — same protection
- **Storage bucket** is private — no public URLs, files accessed via signed URLs only

---

## 📱 Notification System

### SMS (choose one provider)
```bash
# Option A: Twilio (international)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_VERIFY_SID=VA...   # for OTP
TWILIO_FROM=+91XXXXXXXXXX

# Option B: MSG91 (India — better delivery, DLT required)
USE_MSG91=true
MSG91_AUTH_KEY=...
MSG91_SENDER_ID=MEDCRE
```

### When notifications fire
| Event | SMS | Email |
|-------|-----|-------|
| Patient books appointment | — | ✅ Confirmation |
| Reception accepts + assigns slot | ✅ Confirmation | ✅ Confirmation |
| Reception declines | ✅ Decline notice | ✅ Decline notice |
| Doctor writes prescription | — | ✅ Prescription |
| Day before appointment | ✅ Reminder | ✅ Reminder |
| Login with phone on file | ✅ OTP | — |

---

## 💳 Payment Integration (Razorpay)

```bash
# .env
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

**Flow:**
1. Patient selects doctor → slot → fills details
2. Frontend calls `POST /api/payments/create-order` → gets `order_id`
3. Razorpay checkout opens
4. On success → `POST /api/payments/verify` — HMAC signature verified server-side
5. Appointment saved only after verified payment
6. Razorpay sends webhook to `/api/payments/webhook` for async capture events

**Add to api.js:**
```js
const { router: paymentRouter } = require('./payments');
app.use('/api/payments', paymentRouter);
```

---

## ⏰ Appointment Reminders (Cron)

```bash
# Start with PM2 (recommended)
pm2 start reminder.js --name reminders --cron "0 18 * * *"

# Test immediately
node reminder.js --run-now

# Logs
pm2 logs reminders
```

Runs every day at **6 PM IST** — sends SMS + email to patients with accepted appointments the next day.

---

## 🧪 Testing

```bash
cd backend

# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:cover
```

Test suite covers: register, login, OTP flow, RBAC, appointments CRUD, availability, prescriptions, reports, audit log, consent, rate limiting.

---

## 🗄️ Database Migrations

```bash
# Initial setup (run once)
# Paste database_schema.sql in Supabase SQL Editor

# Production features (run after schema)
# Paste migration_v2.sql in Supabase SQL Editor

# Verify migration ran correctly — look for:
# NOTICE:  ✅ Migration v2 verified successfully
```

New columns added by migration_v2.sql:
- `appointments`: `payment_id`, `payment_status`, `sms_sent`, `reminder_sent`
- `doctors/receptionists/patients`: `totp_secret`, `is_active`, `last_login_at`
- New tables: `payments`, `notification_log`, `doctor_availability_exceptions`

---

## 🚀 Deployment

### Backend
```bash
# Railway (easiest)
npm install -g @railway/cli && railway login && railway up

# Render.com
# Build: npm install  |  Start: node api.js

# VPS (Ubuntu)
pm2 start api.js --name medicare-api
pm2 start reminder.js --name reminders --cron "0 18 * * *"
pm2 startup && pm2 save
sudo nginx -t && sudo certbot --nginx -d api.yourdomain.com
```

### Frontend
```bash
# Update API URL in every HTML file before deploying:
# const API = 'https://api.yourdomain.com/api';

# Netlify: drag-and-drop the frontend/ folder
# Vercel:  vercel deploy
# Nginx:   cp -r frontend/* /var/www/html/
```

---

## ⚖️ Legal Compliance

| Regulation | Status | Details |
|-----------|--------|---------|
| DPDPA 2023 | ✅ Implemented | Consent modal, DPO contact, data rights table in privacy policy |
| MCI Data Retention | ✅ Addressed | 7-year retention for medical records noted in privacy policy |
| TRAI DLT | ⚠️ Action needed | Register SMS templates at trai.gov.in/dlt before bulk SMS |
| PCI-DSS | ✅ Compliant | Card data handled by Razorpay — we store only transaction IDs |
| IT Act 2000 | ✅ Compliant | Data encrypted in transit (TLS) and at rest (AES-256) |

---

## 📋 Pre-Launch Checklist

Open `deployment_checklist.html` in a browser for the interactive version. Critical items:

- [ ] `JWT_SECRET` is 64+ random bytes
- [ ] `SUPABASE_SERVICE_ROLE_KEY` only in backend `.env`, never in HTML
- [ ] `STAFF_CODE` changed from default
- [ ] RLS enabled on all tables (verify in Supabase dashboard)
- [ ] `patient-reports` storage bucket is **private**
- [ ] Razorpay key switched from `rzp_test_` to `rzp_live_`
- [ ] DLT registration complete before sending bulk SMS
- [ ] `node check-env.js` passes all critical checks
- [ ] `npm test` passes all tests
- [ ] HTTPS on both API and frontend domains

---

## 📞 Support

- **Supabase:** https://supabase.com/docs
- **Twilio Verify:** https://www.twilio.com/docs/verify
- **MSG91:** https://msg91.com/help
- **Razorpay:** https://razorpay.com/docs
- **DPDPA:** https://meity.gov.in/data-protection-framework
- **DLT Registration:** https://www.trai.gov.in/dlt

---

*Built with Express.js · Supabase · bcrypt · JWT · Twilio/MSG91 · Razorpay · EmailJS · Vanilla HTML/CSS/JS*
