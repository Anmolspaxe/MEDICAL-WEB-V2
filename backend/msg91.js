/**
 * MediCare Hospital — MSG91 SMS Module (India)
 * ============================================
 * Drop-in replacement for Twilio in api.js for Indian phone numbers.
 * MSG91 is cheaper, has better delivery rates in India, and supports
 * DLT-registered templates (required by TRAI for transactional SMS).
 *
 * SETUP:
 * 1. Register at https://msg91.com
 * 2. Complete DLT registration (mandatory for India commercial SMS):
 *    - Go to https://www.trai.gov.in/dlt
 *    - Register your entity and template IDs
 *    - Takes 2–5 business days
 * 3. Add to .env:
 *    MSG91_AUTH_KEY=your_auth_key
 *    MSG91_SENDER_ID=MEDCRE          (6-char registered sender ID)
 *    MSG91_OTP_TEMPLATE_ID=          (DLT template ID for OTP)
 *    MSG91_CONFIRM_TEMPLATE_ID=      (DLT template ID for confirmations)
 *    MSG91_DECLINE_TEMPLATE_ID=      (DLT template ID for declines)
 *
 * Install: npm install axios
 *
 * USAGE in api.js — replace Twilio calls with these functions:
 *   const { sendOtp, verifyOtp, sendSms } = require('./msg91');
 *   await sendOtp('+919876543210');
 *   await verifyOtp('+919876543210', '123456');
 *   await sendSms('+919876543210', 'CONFIRM', { name:'Rahul', doctor:'Dr. Sharma' });
 */

'use strict';
require('dotenv').config();
const axios = require('axios');

const AUTH_KEY          = process.env.MSG91_AUTH_KEY;
const SENDER_ID         = process.env.MSG91_SENDER_ID     || 'MEDCRE';
const OTP_TEMPLATE_ID   = process.env.MSG91_OTP_TEMPLATE_ID;
const CONFIRM_TEMPLATE  = process.env.MSG91_CONFIRM_TEMPLATE_ID;
const DECLINE_TEMPLATE  = process.env.MSG91_DECLINE_TEMPLATE_ID;

// ── OTP FLOW ────────────────────────────────────────────────────────────

/**
 * Send OTP via MSG91 Verify API
 * @param {string} phone - E.164 format e.g. +919876543210
 * @returns {Promise<{type: string, message: string}>}
 */
async function sendOtp(phone) {
  if (!AUTH_KEY) throw new Error('MSG91_AUTH_KEY not set in .env');

  // Strip + for MSG91
  const mobile = phone.replace(/^\+/, '');

  const resp = await axios.post('https://control.msg91.com/api/v5/otp', {
    template_id: OTP_TEMPLATE_ID,
    mobile,
    authkey:    AUTH_KEY,
    otp_length: 6,
    otp_expiry: 10  // minutes
  }, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (resp.data.type !== 'success') {
    throw new Error('MSG91 OTP send failed: ' + JSON.stringify(resp.data));
  }
  return resp.data;
}

/**
 * Verify OTP entered by user
 * @param {string} phone  - E.164 format
 * @param {string} otp    - 6-digit code from user
 * @returns {Promise<boolean>}
 */
async function verifyOtp(phone, otp) {
  if (!AUTH_KEY) throw new Error('MSG91_AUTH_KEY not set in .env');

  const mobile = phone.replace(/^\+/, '');

  const resp = await axios.get('https://control.msg91.com/api/v5/otp/verify', {
    params: { mobile, otp, authkey: AUTH_KEY }
  });

  return resp.data.type === 'success';
}

/**
 * Resend OTP
 * @param {string} phone
 * @param {'text'|'voice'} retryType
 */
async function resendOtp(phone, retryType = 'text') {
  const mobile = phone.replace(/^\+/, '');
  await axios.get('https://control.msg91.com/api/v5/otp/retry', {
    params: { mobile, retrytype: retryType, authkey: AUTH_KEY }
  });
}

// ── TRANSACTIONAL SMS ────────────────────────────────────────────────────

/**
 * Send a transactional SMS using a DLT-registered template
 *
 * @param {string} phone     - E.164 format
 * @param {'CONFIRM'|'DECLINE'|'REMINDER'|'PRESCRIPTION'} type
 * @param {object} vars      - Template variables
 */
async function sendSms(phone, type, vars = {}) {
  if (!AUTH_KEY) { console.warn('MSG91_AUTH_KEY not set — SMS skipped'); return; }

  const mobile = phone.replace(/^\+/, '');

  // Build message based on type
  // NOTE: Message content MUST exactly match your DLT-registered template.
  // Variables in {#var#} placeholders are replaced at send time.
  let template_id, message;

  switch (type) {
    case 'CONFIRM':
      template_id = CONFIRM_TEMPLATE;
      message = buildMessage(
        'Dear {#name#}, your appointment with {#doctor#} on {#date#} at {#time#} is CONFIRMED at MediCare Hospital. Patient ID: {#patient_id#}. Carry valid photo ID. MediCare',
        vars
      );
      break;

    case 'DECLINE':
      template_id = DECLINE_TEMPLATE;
      message = buildMessage(
        'Dear {#name#}, your appointment request at MediCare Hospital on {#date#} could not be confirmed. Please call +91-120-456-7890 to reschedule. MediCare',
        vars
      );
      break;

    case 'REMINDER':
      message = buildMessage(
        'Reminder: Your appointment with {#doctor#} at MediCare Hospital is tomorrow {#date#} at {#time#}. Please arrive 15 min early. Patient ID: {#patient_id#}. MediCare',
        vars
      );
      break;

    case 'PRESCRIPTION':
      message = buildMessage(
        'Dear {#name#}, your prescription from Dr. {#doctor#} has been sent to your email. Diagnosis: {#diagnosis#}. Follow-up: {#followup#}. MediCare Hospital',
        vars
      );
      break;

    default:
      throw new Error('Unknown SMS type: ' + type);
  }

  const payload = {
    flow_id:   template_id || undefined,
    sender:    SENDER_ID,
    mobiles:   '91' + mobile.replace(/^91/, ''), // ensure 91 prefix
    message,
    authkey:   AUTH_KEY,
    route:     4   // Transactional route
  };

  const resp = await axios.post(
    'https://control.msg91.com/api/sendhttp.php',
    null,
    { params: payload }
  );

  // MSG91 returns a string starting with a number on success
  if (typeof resp.data === 'string' && /^\d/.test(resp.data.trim())) {
    return { success: true, messageId: resp.data.trim() };
  }

  throw new Error('MSG91 SMS failed: ' + resp.data);
}

/**
 * Replace {#var#} placeholders with actual values
 */
function buildMessage(template, vars) {
  return template.replace(/\{#(\w+)#\}/g, (_, key) => vars[key] || '—');
}

// ── BULK SMS (appointments reminder) ──────────────────────────────────────

/**
 * Send appointment reminders to multiple patients (next-day reminders)
 * Call this with a cron job: 0 18 * * * (6 PM daily)
 *
 * @param {Array<{phone, name, doctor, date, time, patient_id}>} appointments
 */
async function sendBulkReminders(appointments) {
  const results = [];
  for (const appt of appointments) {
    try {
      const r = await sendSms(appt.phone, 'REMINDER', {
        name:       appt.name,
        doctor:     appt.doctor,
        date:       appt.date,
        time:       appt.time,
        patient_id: appt.patient_id
      });
      results.push({ phone: appt.phone, success: true, ...r });
    } catch(e) {
      results.push({ phone: appt.phone, success: false, error: e.message });
    }
    // Rate limit: MSG91 allows 100 SMS/sec on transactional route
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

// ── HOW TO INTEGRATE WITH api.js ─────────────────────────────────────────
/*
  In api.js, replace Twilio sections with:

  // At top of file:
  const { sendOtp, verifyOtp, sendSms } = require('./msg91');

  // In POST /api/auth/login — replace sendSmsOtp(phone):
  await sendOtp(phone);

  // In POST /api/auth/verify-otp — replace verifySmsOtp(phone, code):
  const ok = await verifyOtp(phone, code);

  // In PATCH /api/appointments/:id/status — replace twilioClient.messages.create():
  if (status === 'accepted' && data.phone) {
    await sendSms(data.phone, 'CONFIRM', {
      name:       data.name,
      doctor:     data.doctor,
      date:       data.appointment_date,
      time:       confirmed_time || data.time,
      patient_id: data.patient_id || '—'
    });
  }
  if (status === 'declined' && data.phone) {
    await sendSms(data.phone, 'DECLINE', {
      name: data.name,
      date: data.appointment_date
    });
  }
*/

module.exports = { sendOtp, verifyOtp, resendOtp, sendSms, sendBulkReminders };
