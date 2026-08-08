/**
 * MediCare Hospital — Appointment Reminder Cron Job
 * ==================================================
 * Sends SMS + email reminders to patients the day before their appointment.
 *
 * INSTALL:
 *   npm install node-cron nodemailer @supabase/supabase-js dotenv
 *
 * RUN MANUALLY:
 *   node reminder.js
 *
 * SCHEDULE WITH PM2 (recommended):
 *   pm2 start reminder.js --name reminders --cron "0 18 * * *"
 *   (runs every day at 6 PM — reminds patients about tomorrow's appointments)
 *
 * SCHEDULE WITH SYSTEM CRON (alternative):
 *   crontab -e
 *   0 18 * * * cd /path/to/backend && node reminder.js >> /var/log/reminders.log 2>&1
 *
 * ENVIRONMENT VARIABLES (same .env as api.js):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  (or MSG91 vars)
 *   USE_MSG91=true  (set to use MSG91 instead of Twilio)
 */

'use strict';
require('dotenv').config();

const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// Optional SMS providers
let twilioClient = null;
let msg91        = null;

if (process.env.TWILIO_ACCOUNT_SID && !process.env.USE_MSG91) {
  twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else if (process.env.MSG91_AUTH_KEY) {
  msg91 = require('./msg91');
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ── CORE: fetch tomorrow's appointments ──────────────────────────────────

async function getTomorrowAppointments() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  const { data, error } = await sb
    .from('appointments')
    .select('*')
    .eq('appointment_date', dateStr)
    .eq('status', 'accepted')         // only confirmed appointments
    .eq('reminder_sent', false);      // not already reminded

  if (error) throw new Error('Supabase fetch error: ' + error.message);
  return data || [];
}

// ── EMAIL REMINDER ───────────────────────────────────────────────────────

async function sendEmailReminder(appt) {
  if (!process.env.SMTP_USER || !appt.email) return;

  const dateFormatted = new Date(appt.appointment_date + 'T00:00:00')
    .toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const timeFormatted = appt.confirmed_time || formatTime(appt.time);

  await mailer.sendMail({
    from:    `"MediCare Hospital" <${process.env.SMTP_USER}>`,
    to:      appt.email,
    subject: `⏰ Reminder: Your appointment tomorrow at MediCare`,
    html: `
<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;background:#f4f8f7;padding:24px;margin:0;">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
  <div style="background:#1a2e44;padding:24px 28px;">
    <h2 style="color:#fff;margin:0;font-size:20px;">🏥 MediCare Hospital</h2>
    <p style="color:rgba(255,255,255,.55);margin:6px 0 0;font-size:13px;">Appointment Reminder</p>
  </div>
  <div style="padding:24px 28px;">
    <div style="background:#e6faf7;border:2px solid #00c9a7;border-radius:12px;padding:16px;text-align:center;margin-bottom:20px;">
      <div style="font-size:28px;margin-bottom:4px;">⏰</div>
      <div style="font-size:18px;font-weight:800;color:#00a88a;">Your appointment is TOMORROW</div>
    </div>
    <p style="font-size:15px;color:#1a2e44;margin-bottom:16px;">Dear <strong>${appt.name}</strong>,</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr style="border-bottom:1px solid #f0f4f8;"><td style="padding:9px 0;color:#718096;font-size:13px;">Patient ID</td><td style="padding:9px 0;font-weight:700;font-size:13px;font-family:monospace;">${appt.patient_id || '—'}</td></tr>
      <tr style="border-bottom:1px solid #f0f4f8;"><td style="padding:9px 0;color:#718096;font-size:13px;">Doctor</td><td style="padding:9px 0;font-weight:700;font-size:13px;">${appt.doctor || '—'}</td></tr>
      <tr style="border-bottom:1px solid #f0f4f8;"><td style="padding:9px 0;color:#718096;font-size:13px;">Date</td><td style="padding:9px 0;font-weight:700;font-size:13px;color:#00a88a;">${dateFormatted}</td></tr>
      <tr style="border-bottom:1px solid #f0f4f8;"><td style="padding:9px 0;color:#718096;font-size:13px;">Time</td><td style="padding:9px 0;font-weight:700;font-size:13px;color:#00a88a;">${timeFormatted}</td></tr>
      <tr><td style="padding:9px 0;color:#718096;font-size:13px;">Reason</td><td style="padding:9px 0;font-weight:700;font-size:13px;">${appt.subject || '—'}</td></tr>
    </table>
    <div style="margin-top:18px;background:#fff8e1;border-radius:10px;padding:14px 16px;">
      <p style="font-size:13px;color:#78350f;font-weight:600;margin-bottom:6px;">📋 Please remember to:</p>
      <ul style="font-size:13px;color:#92400e;padding-left:18px;line-height:1.8;">
        <li>Arrive <strong>15 minutes early</strong></li>
        <li>Bring a <strong>valid photo ID</strong></li>
        <li>Carry your <strong>Patient ID: ${appt.patient_id || '—'}</strong></li>
        <li>Bring any previous medical records if relevant</li>
      </ul>
    </div>
    <hr style="border:none;border-top:1px solid #f0f4f8;margin:20px 0;"/>
    <p style="color:#718096;font-size:12px;">Need to reschedule? Call us at <strong>+91 120 456 7890</strong> at least 2 hours before your appointment.</p>
    <p style="color:#718096;font-size:12px;margin-top:6px;">📍 Sector 5, Vaishali, Ghaziabad – 201010</p>
  </div>
</div></body></html>`
  });
}

// ── SMS REMINDER ─────────────────────────────────────────────────────────

async function sendSmsReminder(appt) {
  if (!appt.phone) return;

  const timeStr = appt.confirmed_time || formatTime(appt.time);
  const message = `MediCare Reminder: Your appointment with ${appt.doctor} is TOMORROW ${appt.appointment_date} at ${timeStr}. Patient ID: ${appt.patient_id || '—'}. Arrive 15 mins early. Call +91-120-456-7890 to reschedule.`;

  if (twilioClient) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM,
      to:   appt.phone,
      body: message
    });
  } else if (msg91) {
    await msg91.sendSms(appt.phone, 'REMINDER', {
      name:       appt.name,
      doctor:     appt.doctor,
      date:       appt.appointment_date,
      time:       timeStr,
      patient_id: appt.patient_id || '—'
    });
  } else {
    console.log(`[SMS SKIPPED - no provider configured] → ${appt.phone}: ${message}`);
  }
}

// ── MARK REMINDED ────────────────────────────────────────────────────────

async function markReminded(id) {
  await sb.from('appointments')
    .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
    .eq('id', id);
}

// ── MAIN RUNNER ──────────────────────────────────────────────────────────

async function sendReminders() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] 🔔 Starting appointment reminders…`);

  let appointments;
  try {
    appointments = await getTomorrowAppointments();
  } catch(e) {
    console.error('❌ Failed to fetch appointments:', e.message);
    return;
  }

  if (!appointments.length) {
    console.log('✅ No appointments to remind for tomorrow.');
    return;
  }

  console.log(`📋 Found ${appointments.length} appointment(s) to remind.`);

  const results = { success: 0, emailFailed: 0, smsFailed: 0 };

  for (const appt of appointments) {
    console.log(`\n  → ${appt.name} (${appt.patient_id}) — ${appt.doctor} @ ${appt.confirmed_time || appt.time}`);

    // Email reminder
    try {
      await sendEmailReminder(appt);
      console.log(`    📧 Email sent to ${appt.email}`);
    } catch(e) {
      console.warn(`    📧 Email FAILED: ${e.message}`);
      results.emailFailed++;
    }

    // SMS reminder
    try {
      await sendSmsReminder(appt);
      console.log(`    📱 SMS sent to ${appt.phone}`);
    } catch(e) {
      console.warn(`    📱 SMS FAILED: ${e.message}`);
      results.smsFailed++;
    }

    // Mark reminded (even if SMS/email partially failed — avoid duplicate reminders)
    try {
      await markReminded(appt.id);
    } catch(e) {
      console.warn(`    ⚠️  Failed to mark reminder: ${e.message}`);
    }

    // Audit log
    try {
      await sb.from('audit_logs').insert([{
        action:       'REMINDER_SENT',
        actor_id:     'cron',
        actor_role:   'system',
        target_table: 'appointments',
        target_id:    appt.id,
        meta:          { email: appt.email, phone: appt.phone },
        created_at:    new Date().toISOString()
      }]);
    } catch(e) { /* non-critical */ }

    results.success++;

    // Small delay to avoid overwhelming email/SMS providers
    await new Promise(r => setTimeout(r, 200));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${results.success} reminded, ${results.emailFailed} email failures, ${results.smsFailed} SMS failures`);
}

// ── SCHEDULE ─────────────────────────────────────────────────────────────

// Run every day at 6:00 PM IST
// Adjust timezone: 'Asia/Kolkata' for IST
cron.schedule('0 18 * * *', () => {
  sendReminders().catch(e => console.error('Cron error:', e));
}, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Reminder cron job started — runs daily at 6:00 PM IST');
console.log('   To test immediately, run: node reminder.js --run-now');

// Allow manual trigger for testing: node reminder.js --run-now
if (process.argv.includes('--run-now')) {
  console.log('🔧 Manual trigger — running reminders now…');
  sendReminders().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

// ── HELPERS ──────────────────────────────────────────────────────────────

function formatTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const H = parseInt(h);
  return (H % 12 || 12) + ':' + m + ' ' + (H < 12 ? 'AM' : 'PM');
}

module.exports = { sendReminders };
