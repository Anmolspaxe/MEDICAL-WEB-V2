-- ═══════════════════════════════════════════════════════════════════════════
-- MediCare Hospital — Complete Supabase Schema + RLS Policies
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── DOCTORS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctors (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_id     text UNIQUE NOT NULL,
  name          text NOT NULL,
  email         text UNIQUE NOT NULL,
  department    text NOT NULL,
  phone         text,
  password_hash text NOT NULL,
  totp_secret   text,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- ── RECEPTIONISTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receptionists (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      text UNIQUE NOT NULL,
  name          text NOT NULL,
  email         text UNIQUE NOT NULL,
  phone         text,
  password_hash text NOT NULL,
  totp_secret   text,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- ── PATIENTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id    text UNIQUE NOT NULL,
  name          text NOT NULL,
  email         text UNIQUE NOT NULL,
  phone         text NOT NULL,
  age           int,
  gender        text,
  password_hash text NOT NULL,
  totp_secret   text,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- ── APPOINTMENTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id       text,
  name             text NOT NULL,
  email            text NOT NULL,
  phone            text,
  gender           text,
  age              int,
  appointment_date date NOT NULL,
  time             time,
  confirmed_time   text,
  subject          text,
  reason           text,
  doctor           text NOT NULL,
  status           text DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined')),
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION trg_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS
$$BEGIN NEW.updated_at = now(); RETURN NEW; END;$$;

DROP TRIGGER IF EXISTS appt_updated_at ON appointments;
CREATE TRIGGER appt_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- ── DOCTOR AVAILABILITY ───────────────────────────────────────────────────
-- schedule JSON example:
--   {"mon":[{"start":"09:00","end":"17:00"}], "tue":[...], ...}
CREATE TABLE IF NOT EXISTS doctor_availability (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_name text UNIQUE NOT NULL,
  schedule    jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz DEFAULT now()
);

-- ── PRESCRIPTIONS ─────────────────────────────────────────────────────────
-- medicines stored as JSONB array: [{name,dose,frequency,days}]
CREATE TABLE IF NOT EXISTS prescriptions (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id     text,
  patient_name   text,
  patient_email  text,
  doctor_id      text NOT NULL,
  doctor_name    text NOT NULL,
  diagnosis      text NOT NULL,
  medicines      jsonb,
  instructions   text,
  rx_date        date NOT NULL,
  followup_date  date,
  email_sent     boolean DEFAULT false,
  created_at     timestamptz DEFAULT now()
);

-- ── PATIENT REPORTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_reports (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_name  text NOT NULL,
  patient_id    text,
  report_type   text NOT NULL,
  doctor_name   text NOT NULL,
  report_date   date NOT NULL,
  notes         text,
  file_path     text,
  uploaded_by   text NOT NULL,
  uploaded_role text,
  created_at    timestamptz DEFAULT now()
);

-- ── PATIENT CONSENTS (DPDPA 2023 / ABDM) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_consents (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id   text NOT NULL,
  version      text NOT NULL,   -- e.g. "privacy_v1_2024"
  accepted     boolean NOT NULL,
  ip           text,
  user_agent   text,
  consented_at timestamptz DEFAULT now()
);

-- ── AUDIT LOGS (tamper-evident, append-only) ──────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  actor_id     text,
  actor_role   text,
  target_table text,
  target_id    text,
  meta         jsonb,
  ip           text,
  created_at   timestamptz DEFAULT now()
);

-- Audit log is append-only: revoke UPDATE/DELETE from every role
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_logs FROM authenticated;
REVOKE UPDATE, DELETE ON audit_logs FROM anon;

-- ── INDEXES ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_appt_patient    ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_doctor     ON appointments(doctor);
CREATE INDEX IF NOT EXISTS idx_appt_date       ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appt_status     ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_rx_patient      ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_rx_doctor       ON prescriptions(doctor_id);
CREATE INDEX IF NOT EXISTS idx_report_patient  ON patient_reports(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_patient ON patient_consents(patient_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- All data access goes through the backend (service_role bypasses RLS).
-- The anon key used on the frontend gets only public read on doctors.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE appointments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE receptionists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_consents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_availability ENABLE ROW LEVEL SECURITY;

-- Doctors list — public read (for appointment booking dropdown)
CREATE POLICY "public_read_doctors" ON doctors
  FOR SELECT TO anon USING (is_active = true);

-- Doctor availability — public read (for booking calendar)
CREATE POLICY "public_read_availability" ON doctor_availability
  FOR SELECT TO anon USING (true);

-- All sensitive tables: deny direct anon access
-- (backend API uses service_role which bypasses RLS)
CREATE POLICY "deny_anon_appointments"  ON appointments      FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_prescriptions" ON prescriptions     FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_reports"       ON patient_reports   FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_patients"      ON patients          FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_receptionists" ON receptionists     FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_audit"         ON audit_logs        FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_consents"      ON patient_consents  FOR ALL TO anon USING (false);

-- ═══════════════════════════════════════════════════════════════════════════
-- STORAGE BUCKET: patient-reports
-- Create this bucket in Supabase Dashboard → Storage first,
-- then run these policies.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'patient-reports', 'patient-reports',
  false,         -- NOT public — requires signed URLs
  20971520,      -- 20 MB max
  ARRAY['image/jpeg','image/png','image/gif','application/pdf']
) ON CONFLICT (id) DO NOTHING;

-- Only backend (service_role) can upload
CREATE POLICY "service_upload" ON storage.objects
  FOR INSERT TO service_role WITH CHECK (bucket_id = 'patient-reports');

-- Authenticated users can read (backend issues signed URLs)
CREATE POLICY "auth_read" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'patient-reports');

-- ═══════════════════════════════════════════════════════════════════════════
-- HELPFUL STATS VIEW
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW appointment_stats AS
SELECT
  COUNT(*)                                                AS total,
  COUNT(*) FILTER (WHERE status = 'pending')             AS pending,
  COUNT(*) FILTER (WHERE status = 'accepted')            AS accepted,
  COUNT(*) FILTER (WHERE status = 'declined')            AS declined,
  COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE) AS today
FROM appointments;

-- ═══════════════════════════════════════════════════════════════════════════
-- DONE ✅
-- ═══════════════════════════════════════════════════════════════════════════
