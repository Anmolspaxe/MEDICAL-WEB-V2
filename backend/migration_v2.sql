-- ═══════════════════════════════════════════════════════════════════════════
-- MediCare Hospital — Database Migration v2
-- Run this AFTER the base database_schema.sql to add production features
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Safe to run multiple times (uses IF NOT EXISTS / DO $$ patterns)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── APPOINTMENTS: payment & reminder columns ──────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS payment_id          text,
  ADD COLUMN IF NOT EXISTS payment_order_id    text,
  ADD COLUMN IF NOT EXISTS payment_status      text DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'paid', 'captured', 'failed', 'refunded')),
  ADD COLUMN IF NOT EXISTS sms_sent            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_sent_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- ── DOCTORS: 2FA and status columns ──────────────────────────────────────
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS totp_secret         text,
  ADD COLUMN IF NOT EXISTS totp_verified       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active           boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at       timestamptz,
  ADD COLUMN IF NOT EXISTS login_count         int DEFAULT 0;

-- ── RECEPTIONISTS: 2FA and status columns ────────────────────────────────
ALTER TABLE receptionists
  ADD COLUMN IF NOT EXISTS totp_secret         text,
  ADD COLUMN IF NOT EXISTS totp_verified       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active           boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at       timestamptz;

-- ── PATIENTS: 2FA and status columns ─────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS totp_secret         text,
  ADD COLUMN IF NOT EXISTS totp_verified       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active           boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at       timestamptz,
  ADD COLUMN IF NOT EXISTS abha_id             text;   -- ABDM Health ID

-- ── PRESCRIPTIONS: status tracking ───────────────────────────────────────
ALTER TABLE prescriptions
  ADD COLUMN IF NOT EXISTS status              text DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  ADD COLUMN IF NOT EXISTS dispensed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS dispensed_by        text;

-- ── DOCTOR AVAILABILITY: exceptions ──────────────────────────────────────
-- Stores one-off date exceptions (holidays, leave days)
CREATE TABLE IF NOT EXISTS doctor_availability_exceptions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_name text NOT NULL,
  date        date NOT NULL,
  reason      text,
  is_available boolean DEFAULT false,  -- false = blocked, true = extra day
  created_at  timestamptz DEFAULT now(),
  UNIQUE(doctor_name, date)
);

-- ── PAYMENTS: payment records table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id       text,
  patient_name     text,
  patient_email    text,
  doctor_name      text,
  razorpay_order_id   text,
  razorpay_payment_id text UNIQUE,
  amount_paise     int NOT NULL,         -- amount in paise (₹ * 100)
  currency         text DEFAULT 'INR',
  status           text DEFAULT 'created'
    CHECK (status IN ('created','paid','captured','failed','refunded')),
  refund_id        text,
  refund_amount    int,
  created_at       timestamptz DEFAULT now(),
  captured_at      timestamptz,
  refunded_at      timestamptz
);

-- ── NOTIFICATIONS LOG ─────────────────────────────────────────────────────
-- Tracks every SMS and email sent for debugging and compliance
CREATE TABLE IF NOT EXISTS notification_log (
  id              bigserial PRIMARY KEY,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id      text,
  channel         text NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp')),
  type            text NOT NULL,   -- CONFIRM, DECLINE, REMINDER, PRESCRIPTION, OTP
  recipient       text NOT NULL,   -- phone or email
  status          text DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced')),
  provider        text,            -- twilio, msg91, smtp
  provider_msg_id text,
  error           text,
  created_at      timestamptz DEFAULT now()
);

-- ── INDEXES FOR NEW TABLES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_availability_exc_doctor ON doctor_availability_exceptions(doctor_name);
CREATE INDEX IF NOT EXISTS idx_availability_exc_date   ON doctor_availability_exceptions(date);
CREATE INDEX IF NOT EXISTS idx_payments_appt           ON payments(appointment_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient        ON payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_rzp            ON payments(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_appt          ON notification_log(appointment_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_type          ON notification_log(type);
CREATE INDEX IF NOT EXISTS idx_notif_log_ts            ON notification_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appt_payment_status     ON appointments(payment_status);
CREATE INDEX IF NOT EXISTS idx_appt_reminder           ON appointments(reminder_sent, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appt_sms_sent           ON appointments(sms_sent);

-- ── RLS FOR NEW TABLES ────────────────────────────────────────────────────
ALTER TABLE doctor_availability_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log               ENABLE ROW LEVEL SECURITY;

-- Public can read availability exceptions (for booking calendar)
CREATE POLICY "public_read_avail_exc" ON doctor_availability_exceptions
  FOR SELECT TO anon USING (true);

-- Deny anon access to payments and notification log
CREATE POLICY "deny_anon_payments"      ON payments           FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_notif_log"     ON notification_log   FOR ALL TO anon USING (false);

-- Notification log is append-only (like audit_logs)
REVOKE UPDATE, DELETE ON notification_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON notification_log FROM authenticated;
REVOKE UPDATE, DELETE ON notification_log FROM anon;

-- ── UPDATED APPOINTMENT STATS VIEW ───────────────────────────────────────
CREATE OR REPLACE VIEW appointment_stats AS
SELECT
  COUNT(*)                                                    AS total,
  COUNT(*) FILTER (WHERE status = 'pending')                 AS pending,
  COUNT(*) FILTER (WHERE status = 'accepted')                AS accepted,
  COUNT(*) FILTER (WHERE status = 'declined')                AS declined,
  COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE)    AS today,
  COUNT(*) FILTER (WHERE payment_status = 'paid')            AS paid,
  COUNT(*) FILTER (WHERE reminder_sent = true)               AS reminded,
  COUNT(*) FILTER (WHERE sms_sent = true)                    AS sms_sent
FROM appointments;

-- ── REVENUE VIEW ──────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW revenue_summary AS
SELECT
  DATE_TRUNC('month', created_at)  AS month,
  COUNT(*)                         AS total_payments,
  SUM(amount_paise) / 100.0        AS total_revenue_inr,
  AVG(amount_paise) / 100.0        AS avg_consultation_fee_inr,
  COUNT(*) FILTER (WHERE status = 'refunded') AS refunds
FROM payments
WHERE status IN ('captured', 'paid')
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month DESC;

-- ── VERIFY MIGRATION ──────────────────────────────────────────────────────
-- Run this to verify all columns exist after migration:
DO $$
DECLARE
  missing_count int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='payment_id') THEN
    RAISE NOTICE 'MISSING: appointments.payment_id'; missing_count := missing_count + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='sms_sent') THEN
    RAISE NOTICE 'MISSING: appointments.sms_sent'; missing_count := missing_count + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='reminder_sent') THEN
    RAISE NOTICE 'MISSING: appointments.reminder_sent'; missing_count := missing_count + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='payments') THEN
    RAISE NOTICE 'MISSING TABLE: payments'; missing_count := missing_count + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='notification_log') THEN
    RAISE NOTICE 'MISSING TABLE: notification_log'; missing_count := missing_count + 1;
  END IF;

  IF missing_count = 0 THEN
    RAISE NOTICE '✅ Migration v2 verified successfully — all columns and tables present';
  ELSE
    RAISE EXCEPTION '❌ Migration incomplete — % item(s) missing. Check the errors above.', missing_count;
  END IF;
END $$;
