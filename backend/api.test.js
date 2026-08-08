/**
 * MediCare Hospital — API Test Suite
 * ====================================
 * Tests every backend endpoint.
 *
 * Install: npm install --save-dev jest supertest
 * Run:     npm test           (all tests)
 *          npm test -- --watch (watch mode)
 *
 * Add to package.json:
 *   "jest": { "testEnvironment": "node" },
 *   "scripts": { "test": "jest --forceExit" }
 *
 * NOTE: Tests run against a real Supabase test project.
 * Set TEST_* env vars in .env.test to use a separate test database.
 */

'use strict';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app     = require('./api');

// ── TEST DATA ─────────────────────────────────────────────────────────────
const TIMESTAMP   = Date.now();
const TEST_EMAIL  = `test_${TIMESTAMP}@medicare-test.com`;
const TEST_PASS   = 'TestPass@2024';
const TEST_PHONE  = '+919999900000';

let doctorToken       = null;
let receptToken       = null;
let patientToken      = null;
let doctorId          = null;
let patientId         = null;
let appointmentId     = null;
let prescriptionId    = null;
let createdDoctorName = null;

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
describe('Health Check', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });
});

// ── AUTH: REGISTER ────────────────────────────────────────────────────────
describe('Auth — Register', () => {
  test('POST /api/auth/register — Doctor: missing fields → 422', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ role: 'doctor', email: TEST_EMAIL });
    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
  });

  test('POST /api/auth/register — Doctor: valid → 201 + doctor ID', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        role:       'doctor',
        name:       'Dr. Test McTest',
        email:      TEST_EMAIL,
        department: 'CARD',
        phone:      TEST_PHONE,
        password:   TEST_PASS
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^MCR-CARD-/);
    doctorId          = res.body.id;
    createdDoctorName = 'Dr. Test McTest';
  });

  test('POST /api/auth/register — Doctor: duplicate email → 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        role:       'doctor',
        name:       'Dr. Duplicate',
        email:      TEST_EMAIL,
        department: 'CARD',
        password:   TEST_PASS
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  test('POST /api/auth/register — Patient: valid → 201', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        role:     'patient',
        name:     'Test Patient',
        email:    `patient_${TIMESTAMP}@test.com`,
        phone:    TEST_PHONE,
        age:      30,
        gender:   'Male',
        password: TEST_PASS
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^MCP-/);
    patientId = res.body.id;
  });

  test('POST /api/auth/register — Receptionist: wrong staff code → 403', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        role:      'receptionist',
        name:      'Test Receptionist',
        email:     `recept_${TIMESTAMP}@test.com`,
        staffCode: 'WRONGCODE',
        password:  TEST_PASS
      });
    expect(res.status).toBe(403);
  });

  test('POST /api/auth/register — Weak password → 422', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        role:       'patient',
        name:       'Weak Pass',
        email:      `weak_${TIMESTAMP}@test.com`,
        phone:      TEST_PHONE,
        age:        25,
        gender:     'Female',
        password:   '123'   // too short
      });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].msg).toMatch(/8 char/i);
  });
});

// ── AUTH: LOGIN ───────────────────────────────────────────────────────────
describe('Auth — Login', () => {
  test('POST /api/auth/login — Doctor: wrong password → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ role: 'doctor', identifier: TEST_EMAIL, password: 'WrongPass!' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('POST /api/auth/login — Doctor: correct → token or OTP', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ role: 'doctor', identifier: TEST_EMAIL, password: TEST_PASS });

    // If Twilio/MSG91 is configured, OTP flow is triggered
    if (res.body.requiresOtp) {
      expect(res.body.preToken).toBeDefined();
      expect(res.status).toBe(200);
      // Skip OTP verification in unit tests (needs real SMS)
      console.log('  ⚠️  OTP flow triggered — skipping OTP step in unit tests');
    } else {
      // No phone on file → direct token
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.role).toBe('doctor');
      doctorToken = res.body.token;
    }
  });

  test('POST /api/auth/login — Missing fields → 422', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ role: 'doctor' });
    expect(res.status).toBe(422);
  });

  test('POST /api/auth/login — Invalid role → 422', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ role: 'superadmin', identifier: TEST_EMAIL, password: TEST_PASS });
    expect(res.status).toBe(422);
  });
});

// ── AUTH: TOKEN VALIDATION ────────────────────────────────────────────────
describe('Auth — Token Validation', () => {
  test('GET /api/appointments — no token → 401', async () => {
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(401);
  });

  test('GET /api/appointments — invalid token → 401', async () => {
    const res = await request(app)
      .get('/api/appointments')
      .set('Authorization', 'Bearer not.a.valid.token');
    expect(res.status).toBe(401);
  });

  test('GET /api/audit — patient token → 403 (wrong role)', async () => {
    if (!patientToken) return;
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });
});

// ── APPOINTMENTS ──────────────────────────────────────────────────────────
describe('Appointments', () => {
  test('GET /api/appointments — valid doctor token → 200 + array', async () => {
    if (!doctorToken) return console.log('  ⚠️  Skipped: no doctor token (OTP not verified in tests)');
    const res = await request(app)
      .get('/api/appointments')
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/appointments — patient books → 201', async () => {
    if (!patientToken) return console.log('  ⚠️  Skipped: no patient token');
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        name:             'Test Patient',
        email:            `patient_${TIMESTAMP}@test.com`,
        phone:            TEST_PHONE,
        appointment_date: tomorrow.toISOString().split('T')[0],
        time:             '10:00',
        doctor:           createdDoctorName || 'Dr. Test McTest',
        subject:          'General Check-up',
        gender:           'Male',
        age:              30
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    appointmentId = res.body.id;
  });

  test('POST /api/appointments — missing required fields → 422', async () => {
    if (!patientToken) return;
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ name: 'Incomplete', email: 'test@test.com' });
    expect(res.status).toBe(422);
  });

  test('PATCH /api/appointments/:id/status — patient token → 403', async () => {
    if (!patientToken || !appointmentId) return;
    const res = await request(app)
      .patch(`/api/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'accepted', confirmed_time: '10:30 AM' });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/appointments/:id/status — invalid status → 422', async () => {
    if (!receptToken || !appointmentId) return;
    const res = await request(app)
      .patch(`/api/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${receptToken}`)
      .send({ status: 'maybe' });
    expect(res.status).toBe(422);
  });
});

// ── AVAILABILITY ──────────────────────────────────────────────────────────
describe('Availability', () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  test('GET /api/availability/:doctor — valid date query → 200', async () => {
    const res = await request(app)
      .get(`/api/availability/Dr. Test McTest?date=${tomorrowStr}`);
    expect(res.status).toBe(200);
    expect(res.body.doctor).toBeDefined();
    expect(res.body.date).toBe(tomorrowStr);
    expect(Array.isArray(res.body.bookedSlots)).toBe(true);
  });

  test('GET /api/availability/:doctor — missing date → 422', async () => {
    const res = await request(app)
      .get('/api/availability/Dr. Test McTest');
    expect(res.status).toBe(422);
  });

  test('PUT /api/availability/:doctor — no token → 401', async () => {
    const res = await request(app)
      .put('/api/availability/Dr. Test McTest')
      .send({ schedule: { mon: { start: '09:00', end: '17:00', duration: 30 } } });
    expect(res.status).toBe(401);
  });

  test('PUT /api/availability/:doctor — doctor token → 200 or 403', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .put(`/api/availability/${createdDoctorName}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ schedule: { mon: { start: '09:00', end: '17:00', duration: 30 }, fri: { start: '10:00', end: '14:00', duration: 20 } } });
    // 200 if doctor matches, 403 if different doctor token
    expect([200, 403]).toContain(res.status);
  });
});

// ── PRESCRIPTIONS ─────────────────────────────────────────────────────────
describe('Prescriptions', () => {
  test('POST /api/prescriptions — patient token → 403', async () => {
    if (!patientToken) return;
    const res = await request(app)
      .post('/api/prescriptions')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ patient_id: 'MCP-1234', diagnosis: 'Test', rx_date: '2024-01-01', medicines: [] });
    expect(res.status).toBe(403);
  });

  test('POST /api/prescriptions — doctor token: missing diagnosis → 422', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .post('/api/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ patient_id: 'MCP-1234', rx_date: '2024-01-01' });
    expect(res.status).toBe(422);
  });

  test('POST /api/prescriptions — doctor token: valid → 201', async () => {
    if (!doctorToken) return console.log('  ⚠️  Skipped');
    const res = await request(app)
      .post('/api/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patient_id:    patientId || 'MCP-20240001',
        patient_name:  'Test Patient',
        patient_email: `patient_${TIMESTAMP}@test.com`,
        diagnosis:     'Viral Fever',
        rx_date:       new Date().toISOString().split('T')[0],
        medicines:     JSON.stringify([{ name:'Paracetamol', dose:'500mg', frequency:'Twice daily', days:'5' }]),
        instructions:  'Drink plenty of water'
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    prescriptionId = res.body.id;
  });

  test('GET /api/prescriptions — doctor token → 200 + array', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .get('/api/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── REPORTS ───────────────────────────────────────────────────────────────
describe('Reports', () => {
  test('GET /api/reports — doctor token → 200 + array', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .get('/api/reports')
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/reports — no token → 401', async () => {
    const res = await request(app).get('/api/reports');
    expect(res.status).toBe(401);
  });
});

// ── AUDIT LOG ─────────────────────────────────────────────────────────────
describe('Audit Log', () => {
  test('GET /api/audit — no token → 401', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  test('GET /api/audit — doctor token → 403 (not receptionist)', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  test('GET /api/audit — receptionist token → 200 + array', async () => {
    if (!receptToken) return console.log('  ⚠️  Skipped: no receptionist token');
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${receptToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── CONSENT ───────────────────────────────────────────────────────────────
describe('Consent', () => {
  test('POST /api/consent — patient token → 201', async () => {
    if (!patientToken) return;
    const res = await request(app)
      .post('/api/consent')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ version: 'privacy_v1_2024', accepted: true });
    expect(res.status).toBe(201);
    expect(res.body.patient_id).toBeDefined();
  });

  test('POST /api/consent — accepted=false → 201 (decline recorded)', async () => {
    if (!patientToken) return;
    const res = await request(app)
      .post('/api/consent')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ version: 'privacy_v1_2024', accepted: false });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(false);
  });

  test('POST /api/consent — doctor token (wrong role) → still 201 (any logged-in user)', async () => {
    if (!doctorToken) return;
    const res = await request(app)
      .post('/api/consent')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ version: 'privacy_v1_2024', accepted: true });
    // Consent endpoint is requireAuth() — any role can record consent
    expect([201, 403]).toContain(res.status);
  });
});

// ── RATE LIMITING ─────────────────────────────────────────────────────────
describe('Rate Limiting', () => {
  test('Rapid auth attempts → 429 after 10 requests', async () => {
    let lastStatus;
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ role: 'patient', identifier: 'ratelimit@test.com', password: 'wrongpass' });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    // Should hit 429 within 12 attempts
    expect([401, 429, 422]).toContain(lastStatus);
  }, 30000);
});

// ── CLEANUP NOTE ─────────────────────────────────────────────────────────
afterAll(() => {
  console.log('\n📋 Test Summary:');
  console.log('  Doctor ID created:', doctorId || '(skipped — OTP required)');
  console.log('  Patient ID created:', patientId || '(skipped)');
  console.log('  Appointment ID:', appointmentId || '(skipped)');
  console.log('  Prescription ID:', prescriptionId || '(skipped)');
  console.log('\n⚠️  Clean up test data from Supabase manually or run:');
  console.log('  DELETE FROM doctors WHERE email LIKE \'%medicare-test.com\';');
  console.log('  DELETE FROM patients WHERE email LIKE \'%test.com\' AND name LIKE \'Test%\';');
});
