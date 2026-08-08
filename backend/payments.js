/**
 * MediCare Hospital — Razorpay Payment Verification
 * ==================================================
 * Add these routes to api.js for secure server-side payment verification.
 * Razorpay signs every webhook with HMAC-SHA256 — NEVER trust client-side
 * payment IDs without server-side signature verification.
 *
 * SETUP:
 * 1. Add to .env:
 *    RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXX
 *    RAZORPAY_KEY_SECRET=your_secret_key
 *    RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
 *
 * 2. Install: npm install razorpay
 *
 * 3. In Razorpay Dashboard → Settings → Webhooks:
 *    URL: https://api.yourhospital.com/api/payments/webhook
 *    Events: payment.captured, payment.failed, refund.created
 *
 * 4. In api.js, add at the top:
 *    const { router: paymentRouter } = require('./payments');
 *    app.use('/api/payments', paymentRouter);
 */

'use strict';
require('dotenv').config();
const express    = require('express');
const crypto     = require('crypto');
const Razorpay   = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Razorpay instance
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ── CREATE ORDER ──────────────────────────────────────────────────────────
// Called BEFORE showing Razorpay checkout — creates a server-side order
// Frontend receives order_id, uses it to open checkout
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt, notes } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const order = await razorpay.orders.create({
      amount:   Math.round(amount), // paise, must be integer
      currency,
      receipt:  receipt || 'rcpt_' + Date.now(),
      notes:    notes || {},
      payment_capture: 1
    });

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VERIFY PAYMENT ────────────────────────────────────────────────────────
// Called AFTER successful checkout — verifies HMAC signature
router.post('/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      appointment          // appointment data from frontend
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification fields' });
    }

    // Verify HMAC-SHA256 signature
    const body     = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expected !== razorpay_signature) {
      // Log suspicious activity
      await sb.from('audit_logs').insert([{
        action:       'PAYMENT_SIGNATURE_FAIL',
        actor_id:     appointment?.email || 'unknown',
        actor_role:   'patient',
        target_table: 'payments',
        target_id:    razorpay_payment_id,
        meta:          { orderId: razorpay_order_id, ip: req.ip },
        ip:            req.ip,
        created_at:    new Date().toISOString()
      }]);
      return res.status(400).json({ error: 'Invalid payment signature — possible tampering detected' });
    }

    // Payment is verified — save appointment
    if (appointment) {
      // Get or create patient ID
      const { data: existing } = await sb.from('appointments')
        .select('patient_id').eq('email', appointment.email)
        .not('patient_id', 'is', null).limit(1);

      const patientId = (existing?.length && existing[0].patient_id)
        ? existing[0].patient_id
        : 'MCP-' + new Date().getFullYear() + Math.floor(1000 + Math.random() * 9000);

      const { error: apptError } = await sb.from('appointments').insert([{
        patient_id:       patientId,
        name:             appointment.name,
        email:            appointment.email,
        phone:            appointment.phone,
        age:              appointment.age,
        gender:           appointment.gender,
        appointment_date: appointment.date,
        time:             appointment.time,
        subject:          appointment.subject,
        doctor:           appointment.doctor,
        status:           'pending',
        payment_id:       razorpay_payment_id,
        payment_order_id: razorpay_order_id,
        payment_status:   'paid'
      }]);

      if (apptError) throw apptError;

      // Audit log
      await sb.from('audit_logs').insert([{
        action:       'PAYMENT_SUCCESS',
        actor_id:     patientId,
        actor_role:   'patient',
        target_table: 'appointments',
        target_id:    razorpay_payment_id,
        meta:          { orderId: razorpay_order_id, amount: req.body.amount, ip: req.ip },
        ip:            req.ip,
        created_at:    new Date().toISOString()
      }]);

      return res.json({ success: true, patientId, paymentId: razorpay_payment_id });
    }

    res.json({ success: true, paymentId: razorpay_payment_id });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEBHOOK (Razorpay → Server) ───────────────────────────────────────────
// Razorpay sends signed events for captures, failures, refunds
// Must use raw body (not JSON-parsed) for signature verification
router.post('/webhook',
  express.raw({ type: 'application/json' }),  // CRITICAL: raw body for HMAC
  async (req, res) => {
    try {
      const signature = req.headers['x-razorpay-signature'];
      const body      = req.body;

      // Verify webhook signature
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');

      if (expected !== signature) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }

      const event = JSON.parse(body.toString());

      switch (event.event) {
        case 'payment.captured':
          await handlePaymentCaptured(event.payload.payment.entity);
          break;
        case 'payment.failed':
          await handlePaymentFailed(event.payload.payment.entity);
          break;
        case 'refund.created':
          await handleRefund(event.payload.refund.entity);
          break;
      }

      res.json({ status: 'ok' });
    } catch(e) {
      console.error('Webhook error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

async function handlePaymentCaptured(payment) {
  // Update appointment payment status to confirmed
  await sb.from('appointments')
    .update({ payment_status: 'captured' })
    .eq('payment_id', payment.id);

  await sb.from('audit_logs').insert([{
    action: 'PAYMENT_CAPTURED', actor_id: payment.email || 'razorpay',
    actor_role: 'system', target_table: 'appointments', target_id: payment.id,
    meta: { amount: payment.amount, currency: payment.currency },
    created_at: new Date().toISOString()
  }]);
}

async function handlePaymentFailed(payment) {
  await sb.from('appointments')
    .update({ payment_status: 'failed' })
    .eq('payment_id', payment.id);

  await sb.from('audit_logs').insert([{
    action: 'PAYMENT_FAILED', actor_id: payment.email || 'razorpay',
    actor_role: 'system', target_table: 'appointments', target_id: payment.id,
    meta: { error: payment.error_description },
    created_at: new Date().toISOString()
  }]);
}

async function handleRefund(refund) {
  await sb.from('audit_logs').insert([{
    action: 'PAYMENT_REFUNDED', actor_id: 'system',
    actor_role: 'system', target_table: 'payments', target_id: refund.payment_id,
    meta: { refund_id: refund.id, amount: refund.amount },
    created_at: new Date().toISOString()
  }]);
}

// ── ISSUE REFUND ──────────────────────────────────────────────────────────
router.post('/refund', async (req, res) => {
  try {
    const { payment_id, amount, reason } = req.body;
    if (!payment_id) return res.status(400).json({ error: 'payment_id required' });

    const refund = await razorpay.payments.refund(payment_id, {
      amount: amount || undefined, // omit for full refund
      notes:  { reason: reason || 'Appointment cancelled' }
    });

    await sb.from('audit_logs').insert([{
      action: 'REFUND_ISSUED', actor_id: req.user?.sub || 'admin',
      actor_role: req.user?.role || 'receptionist',
      target_table: 'payments', target_id: payment_id,
      meta: { refund_id: refund.id, amount: refund.amount, reason },
      ip: req.ip, created_at: new Date().toISOString()
    }]);

    res.json({ success: true, refund });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };
