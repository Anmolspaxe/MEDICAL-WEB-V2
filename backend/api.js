/**
 * MediCare Hospital — Production Backend API
 * ============================================
 * Install: npm install express cors helmet express-rate-limit
 *          express-validator morgan dotenv @supabase/supabase-js
 *          bcryptjs jsonwebtoken speakeasy qrcode nodemailer twilio
 *
 * Start:   node api.js
 */
'use strict';
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const morgan      = require('morgan');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const speakeasy   = require('speakeasy');
const QRCode      = require('qrcode');
const nodemailer  = require('nodemailer');
const twilio      = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 4000;

// Supabase — service-role key (NEVER exposed to frontend)
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Twilio (SMS OTP + notifications)
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Nodemailer
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

// Global limiter: 200 req / 15 min / IP
app.use(rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false }));
// Auth limiter: 10 attempts / 15 min / IP
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });

// ── HELPERS ────────────────────────────────────────────────────────────────
async function audit(action, actorId, actorRole, targetTable, targetId, meta={}) {
  await sb.from('audit_logs').insert([{
    action, actor_id: actorId||'anon', actor_role: actorRole||'unknown',
    target_table: targetTable, target_id: String(targetId),
    meta, ip: meta.__ip||null, created_at: new Date().toISOString()
  }]);
}

async function sendSmsOtp(phone) {
  if (!twilioClient) throw new Error('Twilio not configured');
  return twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SID)
    .verifications.create({ to: phone, channel: 'sms' });
}

async function verifySmsOtp(phone, code) {
  if (!twilioClient) throw new Error('Twilio not configured');
  const r = await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SID)
    .verificationChecks.create({ to: phone, code });
  return r.status === 'approved';
}

function signToken(payload, exp='8h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: exp });
}

function requireAuth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization||'').replace('Bearer ','').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const d = jwt.verify(token, process.env.JWT_SECRET);
      if (roles.length && !roles.includes(d.role))
        return res.status(403).json({ error: 'Insufficient permissions' });
      req.user = d; next();
    } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
  };
}

function validate(req, res, next) {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(422).json({ errors: e.array() });
  next();
}

function roleTable(role) {
  return { doctor:{ table:'doctors', idField:'doctor_id' },
           receptionist:{ table:'receptionists', idField:'staff_id' },
           patient:{ table:'patients', idField:'patient_id' } }[role];
}

// ── AUTH: REGISTER ─────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter,
  body('role').isIn(['doctor','receptionist','patient']),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min:8 }),
  body('name').trim().notEmpty(),
  validate,
  async (req, res) => {
    try {
      const { role, email, password, name, department, phone, age, gender, staffCode } = req.body;
      if (role==='receptionist' && staffCode!==process.env.STAFF_CODE)
        return res.status(403).json({ error: 'Invalid staff code' });

      const { table, idField } = roleTable(role);
      const { data: ex } = await sb.from(table).select('id').eq('email',email).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Email already registered' });

      let userId;
      if (role==='doctor') {
        const parts = name.replace(/^dr\.?\s*/i,'').trim().split(/\s+/);
        const ini   = parts.map(p=>p[0]?.toUpperCase()||'').join('').slice(0,3);
        userId = `MCR-${department}-${Math.floor(1000+Math.random()*9000)}-${ini}`;
      } else if (role==='receptionist') {
        userId = 'REC-'+String(Math.floor(1000+Math.random()*9000));
      } else {
        userId = 'MCP-'+new Date().getFullYear()+Math.floor(1000+Math.random()*9000);
      }

      // bcrypt cost-12 — production-safe password hashing
      const hash = await bcrypt.hash(password, 12);
      const rec  = { [idField]:userId, name, email, phone:phone||null, password_hash:hash };
      if (role==='doctor')  rec.department = department;
      if (role==='patient') { rec.age=age; rec.gender=gender; }

      const { error } = await sb.from(table).insert([rec]);
      if (error) throw error;

      await audit('REGISTER', userId, role, table, userId, { __ip:req.ip });
      res.status(201).json({ success:true, id:userId });
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── AUTH: LOGIN — Step 1 (password → OTP or full token) ───────────────────
app.post('/api/auth/login', authLimiter,
  body('identifier').trim().notEmpty(),
  body('password').notEmpty(),
  body('role').isIn(['doctor','receptionist','patient']),
  validate,
  async (req, res) => {
    try {
      const { identifier, password, role } = req.body;
      const { table, idField } = roleTable(role);
      const field = identifier.includes('@') ? 'email' : idField;

      const { data, error } = await sb.from(table).select('*').eq(field,identifier).maybeSingle();
      if (error||!data) {
        await audit('LOGIN_FAIL', identifier, role, table, identifier, { __ip:req.ip });
        return res.status(401).json({ error:'Invalid credentials' });
      }

      const match = await bcrypt.compare(password, data.password_hash);
      if (!match) {
        await audit('LOGIN_FAIL', identifier, role, table, identifier, { __ip:req.ip });
        return res.status(401).json({ error:'Invalid credentials' });
      }

      const userId = data[idField];

      // If phone on file → OTP flow
      if (data.phone && twilioClient) {
        try { await sendSmsOtp(data.phone); } catch(e) { console.warn('OTP:',e.message); }
        const pre = signToken({ sub:userId, role, phase:'otp' }, '10m');
        return res.json({ requiresOtp:true, preToken:pre });
      }

      // No phone → issue full JWT
      const token = signToken({ sub:userId, name:data.name, role, dept:data.department||null, email:data.email });
      await audit('LOGIN', userId, role, table, userId, { __ip:req.ip });
      res.json({ token, user:{ id:userId, name:data.name, role, dept:data.department, email:data.email } });
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── AUTH: VERIFY OTP — Step 2 ─────────────────────────────────────────────
app.post('/api/auth/verify-otp', authLimiter,
  body('code').isLength({ min:4, max:8 }),
  validate,
  async (req, res) => {
    try {
      const pre = (req.headers.authorization||'').replace('Bearer ','').trim();
      if (!pre) return res.status(401).json({ error:'No pre-auth token' });

      let d;
      try { d = jwt.verify(pre, process.env.JWT_SECRET); }
      catch { return res.status(401).json({ error:'Pre-auth token expired' }); }
      if (d.phase!=='otp') return res.status(400).json({ error:'Invalid phase' });

      const { table, idField } = roleTable(d.role);
      const { data } = await sb.from(table).select('*').eq(idField,d.sub).maybeSingle();
      if (!data) return res.status(401).json({ error:'User not found' });

      const ok = await verifySmsOtp(data.phone, req.body.code);
      if (!ok) return res.status(401).json({ error:'Invalid or expired OTP' });

      const token = signToken({ sub:d.sub, name:data.name, role:d.role, dept:data.department||null, email:data.email });
      await audit('LOGIN_OTP', d.sub, d.role, table, d.sub, { __ip:req.ip });
      res.json({ token, user:{ id:d.sub, name:data.name, role:d.role, dept:data.department, email:data.email } });
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── AUTH: TOTP SETUP (Google Authenticator) ───────────────────────────────
app.post('/api/auth/setup-totp', requireAuth(), async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name:`MediCare (${req.user.sub})`, length:20 });
    const qr     = await QRCode.toDataURL(secret.otpauth_url);
    const { table, idField } = roleTable(req.user.role);
    await sb.from(table).update({ totp_secret:secret.base32 }).eq(idField,req.user.sub);
    await audit('TOTP_SETUP', req.user.sub, req.user.role, table, req.user.sub, { __ip:req.ip });
    res.json({ qrCode:qr, secret:secret.base32 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/auth/verify-totp', requireAuth(),
  body('token').isLength({ min:6, max:6 }), validate,
  async (req, res) => {
    try {
      const { table, idField } = roleTable(req.user.role);
      const { data } = await sb.from(table).select('totp_secret').eq(idField,req.user.sub).maybeSingle();
      if (!data?.totp_secret) return res.status(400).json({ error:'TOTP not set up' });
      const ok = speakeasy.totp.verify({ secret:data.totp_secret, encoding:'base32', token:req.body.token, window:1 });
      if (!ok) return res.status(401).json({ error:'Invalid TOTP token' });
      await audit('TOTP_VERIFY', req.user.sub, req.user.role, 'auth', req.user.sub, { __ip:req.ip });
      res.json({ success:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── APPOINTMENTS ───────────────────────────────────────────────────────────
app.get('/api/appointments', requireAuth(), async (req,res) => {
  try {
    let q = sb.from('appointments').select('*').order('appointment_date',{ascending:true});
    if (req.user.role==='patient')     q = q.eq('patient_id',req.user.sub);
    else if (req.user.role==='doctor') q = q.eq('doctor',req.user.name);
    const { data,error } = await q;
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/appointments', requireAuth('patient','receptionist'),
  body('name').trim().notEmpty(), body('email').isEmail(),
  body('appointment_date').isDate(), body('doctor').notEmpty(), validate,
  async (req,res) => {
    try {
      const p = { ...req.body, status:'pending' };
      if (req.user.role==='patient') p.patient_id = req.user.sub;
      const { data,error } = await sb.from('appointments').insert([p]).select().single();
      if (error) throw error;
      await audit('CREATE_APPT', req.user.sub, req.user.role, 'appointments', data.id, { __ip:req.ip });
      await sendAppointmentEmail(data,'pending').catch(e=>console.warn(e.message));
      res.status(201).json(data);
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

app.patch('/api/appointments/:id/status', requireAuth('receptionist'),
  body('status').isIn(['pending','accepted','declined']),
  body('confirmed_time').optional().isString(), validate,
  async (req,res) => {
    try {
      const { status, confirmed_time } = req.body;
      const u = { status }; if (confirmed_time) u.confirmed_time = confirmed_time;
      const { data,error } = await sb.from('appointments').update(u).eq('id',req.params.id).select().single();
      if (error) throw error;
      await audit('UPDATE_APPT_STATUS', req.user.sub, 'receptionist', 'appointments',
        req.params.id, { status, confirmed_time, __ip:req.ip });
      await sendAppointmentEmail(data, status, confirmed_time).catch(e=>console.warn(e.message));
      // SMS
      if (data.phone && twilioClient) {
        const smsBody = status==='accepted'
          ? `MediCare: ✅ Appointment CONFIRMED with ${data.doctor} on ${data.appointment_date} at ${confirmed_time||data.time}. ID: ${data.patient_id||'—'}`
          : `MediCare: Your appointment on ${data.appointment_date} could not be confirmed. Call +91-120-456-7890 to reschedule.`;
        twilioClient.messages.create({ from:process.env.TWILIO_FROM, to:data.phone, body:smsBody })
          .catch(e=>console.warn('SMS:',e.message));
      }
      res.json(data);
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── DOCTOR AVAILABILITY CALENDAR ──────────────────────────────────────────
app.get('/api/availability/:doctorName',
  query('date').isDate(), validate,
  async (req,res) => {
    try {
      const { date } = req.query;
      const { data:appts } = await sb.from('appointments')
        .select('confirmed_time,time,status')
        .eq('doctor',req.params.doctorName)
        .eq('appointment_date',date)
        .in('status',['accepted','pending']);

      const bookedSlots = (appts||[]).map(a=>a.confirmed_time||a.time).filter(Boolean);

      const { data:avail } = await sb.from('doctor_availability')
        .select('schedule').eq('doctor_name',req.params.doctorName).maybeSingle();

      const dow = ['sun','mon','tue','wed','thu','fri','sat'][new Date(date).getDay()];
      const workingHours = avail?.schedule?.[dow] || null;

      res.json({ date, doctor:req.params.doctorName, bookedSlots, workingHours });
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

app.put('/api/availability/:doctorName', requireAuth('doctor'), async (req,res) => {
  try {
    if (req.user.sub!==req.params.doctorName && req.user.name!==req.params.doctorName)
      return res.status(403).json({ error:'Cannot edit another doctor\'s schedule' });
    const { schedule } = req.body;
    const { error } = await sb.from('doctor_availability')
      .upsert([{ doctor_name:req.params.doctorName, schedule }], { onConflict:'doctor_name' });
    if (error) throw error;
    await audit('UPDATE_AVAILABILITY', req.user.sub, 'doctor', 'doctor_availability',
      req.params.doctorName, { __ip:req.ip });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── PRESCRIPTIONS ──────────────────────────────────────────────────────────
app.post('/api/prescriptions', requireAuth('doctor'),
  body('patient_id').notEmpty(), body('diagnosis').notEmpty(), body('rx_date').isDate(), validate,
  async (req,res) => {
    try {
      const p = { ...req.body, doctor_id:req.user.sub, doctor_name:req.user.name };
      const { data,error } = await sb.from('prescriptions').insert([p]).select().single();
      if (error) throw error;
      await audit('CREATE_PRESCRIPTION', req.user.sub, 'doctor', 'prescriptions', data.id, { __ip:req.ip });
      res.status(201).json(data);
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

app.get('/api/prescriptions', requireAuth(), async (req,res) => {
  try {
    let q = sb.from('prescriptions').select('*').order('rx_date',{ascending:false});
    if (req.user.role==='patient')     q = q.eq('patient_id',req.user.sub);
    else if (req.user.role==='doctor') q = q.eq('doctor_id',req.user.sub);
    const { data,error } = await q; if (error) throw error; res.json(data);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── REPORTS ────────────────────────────────────────────────────────────────
app.get('/api/reports', requireAuth(), async (req,res) => {
  try {
    let q = sb.from('patient_reports').select('*').order('created_at',{ascending:false});
    if (req.user.role==='patient') q = q.eq('patient_id',req.user.sub);
    const { data,error } = await q; if (error) throw error; res.json(data);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── AUDIT LOG (receptionist view) ─────────────────────────────────────────
app.get('/api/audit', requireAuth('receptionist'), async (req,res) => {
  try {
    const { data,error } = await sb.from('audit_logs')
      .select('*').order('created_at',{ascending:false}).limit(500);
    if (error) throw error; res.json(data);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── CONSENT (DPDPA 2023) ──────────────────────────────────────────────────
app.post('/api/consent', requireAuth('patient'),
  body('version').notEmpty(), body('accepted').isBoolean(), validate,
  async (req,res) => {
    try {
      const { version, accepted } = req.body;
      const { data,error } = await sb.from('patient_consents').insert([{
        patient_id:req.user.sub, version, accepted,
        ip:req.ip, user_agent:req.headers['user-agent']||'',
        consented_at: new Date().toISOString()
      }]).select().single();
      if (error) throw error;
      await audit('CONSENT', req.user.sub, 'patient', 'patient_consents', data.id, { version, accepted, __ip:req.ip });
      res.status(201).json(data);
    } catch(e) { res.status(500).json({ error:e.message }); }
  }
);

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/api/health', (_,res) => res.json({ status:'ok', ts:new Date().toISOString() }));

// ── EMAIL HELPER ──────────────────────────────────────────────────────────
async function sendAppointmentEmail(appt, status, confirmedTime) {
  if (!process.env.SMTP_USER) return;
  const c = status==='accepted'?'#00c9a7':status==='declined'?'#ef4444':'#f59e0b';
  const s = status==='accepted'?'✅ Appointment Confirmed':status==='declined'?'❌ Appointment Declined':'⏳ Under Review';
  await mailer.sendMail({
    from: `"MediCare Hospital" <${process.env.SMTP_USER}>`,
    to:   appt.email,
    subject: `${s} — MediCare`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f7fbfa;padding:24px;margin:0;">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
  <div style="background:#1a2e44;padding:24px 28px;"><h2 style="color:#fff;margin:0;">🏥 MediCare Hospital</h2></div>
  <div style="padding:24px 28px;">
    <div style="background:${c}15;border:2px solid ${c};border-radius:10px;padding:14px;text-align:center;margin-bottom:18px;">
      <strong style="font-size:18px;color:${c};">${s}</strong></div>
    <p>Dear <strong>${appt.name}</strong>,</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;">
      <tr><td style="padding:8px 0;color:#718096;font-size:13px;">Patient ID</td><td style="padding:8px 0;font-weight:700;font-family:monospace;">${appt.patient_id||'—'}</td></tr>
      <tr><td style="padding:8px 0;color:#718096;font-size:13px;">Doctor</td><td style="padding:8px 0;font-weight:700;">${appt.doctor||'—'}</td></tr>
      <tr><td style="padding:8px 0;color:#718096;font-size:13px;">Date</td><td style="padding:8px 0;font-weight:700;">${appt.appointment_date||'—'}</td></tr>
      ${confirmedTime?`<tr><td style="padding:8px 0;color:#718096;font-size:13px;">Confirmed Time</td><td style="padding:8px 0;font-weight:700;color:#00c9a7;">${confirmedTime}</td></tr>`:''}
      <tr><td style="padding:8px 0;color:#718096;font-size:13px;">Reason</td><td style="padding:8px 0;font-weight:700;">${appt.subject||'—'}</td></tr>
    </table>
    ${status==='accepted'?'<p style="background:#e6faf7;padding:12px;border-radius:8px;font-size:13px;">Please arrive <strong>15 minutes early</strong> with a valid photo ID.</p>':''}
    <hr style="border:none;border-top:1px solid #f0f4f8;margin:18px 0;"/>
    <p style="color:#718096;font-size:12px;">📍 Sector 5, Vaishali, Ghaziabad | 📞 +91 120 456 7890</p>
  </div>
</div></body></html>`
  });
}

app.listen(PORT, () => console.log(`✅  MediCare API → http://localhost:${PORT}`));
module.exports = app;
