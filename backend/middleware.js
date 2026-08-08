/**
 * MediCare Hospital — Reusable Middleware
 * ========================================
 * Import in api.js:
 *   const { requireAuth, requireRole, auditMiddleware, validate, hashPw, signToken } = require('./middleware');
 */
'use strict';
require('dotenv').config();

const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const rateLimit   = require('express-rate-limit');
const { validationResult } = require('express-validator');
const { createClient }     = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── JWT helpers ──────────────────────────────────────────────────────────
function signToken(payload, expiresIn = '8h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// ── Password helpers ─────────────────────────────────────────────────────
async function hashPw(password) {
  return bcrypt.hash(password, 12);   // cost 12 — production standard
}

async function comparePw(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── requireAuth middleware ────────────────────────────────────────────────
function requireAuth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const decoded = verifyToken(token);
      if (roles.length && !roles.includes(decoded.role))
        return res.status(403).json({ error: `Access denied — requires role: ${roles.join(' or ')}` });
      req.user = decoded;
      next();
    } catch (err) {
      const msg = err.name === 'TokenExpiredError' ? 'Session expired — please sign in again' : 'Invalid token';
      return res.status(401).json({ error: msg });
    }
  };
}

// Alias for single-role checks
const requireRole = (...roles) => requireAuth(...roles);

// ── express-validator helper ─────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(422).json({ errors: errors.array() });
  next();
}

// ── Audit logger ─────────────────────────────────────────────────────────
async function audit(action, actorId, actorRole, targetTable, targetId, meta = {}) {
  try {
    await sb.from('audit_logs').insert([{
      action,
      actor_id:     actorId   || 'anonymous',
      actor_role:   actorRole || 'unknown',
      target_table: targetTable,
      target_id:    String(targetId || ''),
      meta,
      ip:           meta.__ip || null,
      created_at:   new Date().toISOString()
    }]);
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// Middleware version — auto-logs every authenticated request
function auditMiddleware(action, targetTable, getTargetId = (req) => req.params?.id) {
  return async (req, res, next) => {
    const orig = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400 && req.user) {
        audit(action, req.user.sub, req.user.role, targetTable,
          getTargetId(req), { __ip: req.ip, method: req.method });
      }
      return orig(body);
    };
    next();
  };
}

// ── Rate limiters ─────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             parseInt(process.env.RATE_LIMIT_GLOBAL || '200'),
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — please try again in 15 minutes' }
});

const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             parseInt(process.env.RATE_LIMIT_AUTH || '10'),
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many login attempts — please wait 15 minutes' }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 10,
  message: { error: 'Too many upload requests' }
});

// ── Role table lookup ─────────────────────────────────────────────────────
function roleTable(role) {
  const map = {
    doctor:       { table: 'doctors',       idField: 'doctor_id'  },
    receptionist: { table: 'receptionists', idField: 'staff_id'   },
    patient:      { table: 'patients',      idField: 'patient_id' }
  };
  if (!map[role]) throw new Error(`Unknown role: ${role}`);
  return map[role];
}

// ── Notification logger ───────────────────────────────────────────────────
async function logNotification({ appointmentId, patientId, channel, type, recipient, status, provider, providerMsgId, error }) {
  try {
    await sb.from('notification_log').insert([{
      appointment_id:  appointmentId || null,
      patient_id:      patientId     || null,
      channel,
      type,
      recipient,
      status:          status       || 'sent',
      provider:        provider     || null,
      provider_msg_id: providerMsgId || null,
      error:           error        || null,
      created_at:      new Date().toISOString()
    }]);
  } catch (e) {
    console.warn('Notification log error:', e.message);
  }
}

// ── Request IP helper ─────────────────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

// ── Error handler middleware ──────────────────────────────────────────────
function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
  res.status(500).json({ error: 'Internal server error' });
}

// ── Not found handler ─────────────────────────────────────────────────────
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

// ── Department map ────────────────────────────────────────────────────────
const DEPT_MAP = {
  CARD:    'Cardiology',
  ORTH:    'Orthopedics',
  NEURO:   'Neurology',
  PEDI:    'Pediatrics',
  DERM:    'Dermatology',
  GYNE:    'Gynecology',
  OPTH:    'Ophthalmology',
  ENT:     'ENT',
  PSYCH:   'Psychiatry',
  GENSURG: 'General Surgery',
  GENMED:  'General Medicine'
};

// ── Consultation fees (INR) ───────────────────────────────────────────────
const CONSULT_FEES = {
  CARD:    parseInt(process.env.FEE_CARD    || '500'),
  ORTH:    parseInt(process.env.FEE_ORTH    || '400'),
  NEURO:   parseInt(process.env.FEE_NEURO   || '500'),
  PEDI:    parseInt(process.env.FEE_PEDI    || '300'),
  DERM:    parseInt(process.env.FEE_DERM    || '350'),
  GYNE:    parseInt(process.env.FEE_GYNE    || '400'),
  OPTH:    parseInt(process.env.FEE_OPTH    || '350'),
  ENT:     parseInt(process.env.FEE_ENT     || '300'),
  PSYCH:   parseInt(process.env.FEE_PSYCH   || '600'),
  GENSURG: parseInt(process.env.FEE_GENSURG || '450'),
  GENMED:  parseInt(process.env.FEE_GENMED  || '250')
};

// ── Format helpers ────────────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

function formatTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const H = parseInt(h);
  return (H % 12 || 12) + ':' + m + ' ' + (H < 12 ? 'AM' : 'PM');
}

module.exports = {
  // Auth
  signToken, verifyToken,
  hashPw, comparePw,
  requireAuth, requireRole,

  // Validation
  validate,

  // Audit
  audit, auditMiddleware,

  // Rate limiters
  globalLimiter, authLimiter, uploadLimiter,

  // DB helpers
  roleTable, sb,

  // Notifications
  logNotification,

  // Request utils
  getIP,

  // Error handlers
  errorHandler, notFoundHandler,

  // Constants
  DEPT_MAP, CONSULT_FEES,

  // Format helpers
  formatDate, formatTime
};
