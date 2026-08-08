/**
 * MediCare Hospital — Environment Variable Checker
 * ==================================================
 * Run before starting the server to catch missing config early.
 *
 * Usage:
 *   node check-env.js          (exits 1 if critical vars missing)
 *   npm run check-env
 */

'use strict';
require('dotenv').config();

const RESET  = '\x1b[0m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';

const CHECKS = [
  // ── CRITICAL — server won't work without these ──────────────────────────
  { key: 'SUPABASE_URL',              level: 'critical', hint: 'Your Supabase project URL (https://xxx.supabase.co)' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', level: 'critical', hint: 'Service role key from Supabase Dashboard → Settings → API (NOT the anon key)' },
  { key: 'JWT_SECRET',                level: 'critical', hint: 'Run: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"' },
  { key: 'STAFF_CODE',                level: 'critical', hint: 'Registration code for receptionists (e.g. HOSP2024SEC!)' },
  { key: 'ALLOWED_ORIGIN',            level: 'critical', hint: 'Frontend URL for CORS (e.g. https://medicare.yourhospital.com)' },

  // ── HIGH — features break without these ─────────────────────────────────
  { key: 'SMTP_USER',                 level: 'high',     hint: 'Gmail address for sending confirmation emails' },
  { key: 'SMTP_PASS',                 level: 'high',     hint: 'Gmail App Password (16 chars from myaccount.google.com/apppasswords)' },

  // ── MEDIUM — SMS / 2FA won't work ───────────────────────────────────────
  { key: 'TWILIO_ACCOUNT_SID',        level: 'medium',   hint: 'From Twilio console (or set USE_MSG91=true and use MSG91_AUTH_KEY instead)' },
  { key: 'TWILIO_AUTH_TOKEN',         level: 'medium',   hint: 'From Twilio console' },
  { key: 'TWILIO_VERIFY_SID',         level: 'medium',   hint: 'Twilio Verify Service SID for SMS OTP' },
  { key: 'TWILIO_FROM',               level: 'medium',   hint: 'Twilio phone number e.g. +919999900000' },

  // ── LOW — Razorpay payments won't work ──────────────────────────────────
  { key: 'RAZORPAY_KEY_ID',           level: 'low',      hint: 'From Razorpay Dashboard (rzp_live_... for production)' },
  { key: 'RAZORPAY_KEY_SECRET',       level: 'low',      hint: 'Razorpay secret key — never expose to frontend' },
  { key: 'RAZORPAY_WEBHOOK_SECRET',   level: 'low',      hint: 'Webhook secret from Razorpay Dashboard → Settings → Webhooks' },
];

// ── SECURITY CHECKS ────────────────────────────────────────────────────────
const SECURITY = [
  {
    label: 'JWT_SECRET length',
    check: () => (process.env.JWT_SECRET || '').length >= 64,
    pass:  'JWT_SECRET is strong (≥64 chars)',
    fail:  'JWT_SECRET is too short! Generate with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
    level: 'critical'
  },
  {
    label: 'Not using default STAFF_CODE',
    check: () => process.env.STAFF_CODE !== 'MCRHOSPITAL2024',
    pass:  'STAFF_CODE has been changed from default',
    fail:  'STAFF_CODE is still the default (MCRHOSPITAL2024) — change it before going live!',
    level: 'high'
  },
  {
    label: 'Not using Supabase anon key as service role',
    check: () => !(process.env.SUPABASE_SERVICE_ROLE_KEY || '').startsWith('sb_publishable'),
    pass:  'SUPABASE_SERVICE_ROLE_KEY looks like a service role key',
    fail:  'SUPABASE_SERVICE_ROLE_KEY looks like an anon key (starts with sb_publishable) — use the service role key!',
    level: 'critical'
  },
  {
    label: 'Production NODE_ENV',
    check: () => process.env.NODE_ENV === 'production',
    pass:  'NODE_ENV=production',
    fail:  'NODE_ENV is not set to "production" — set it in your deployment environment',
    level: 'medium'
  },
  {
    label: 'ALLOWED_ORIGIN uses HTTPS',
    check: () => (process.env.ALLOWED_ORIGIN || '').startsWith('https://') || process.env.NODE_ENV !== 'production',
    pass:  'ALLOWED_ORIGIN uses HTTPS',
    fail:  'ALLOWED_ORIGIN should use HTTPS in production (not HTTP)',
    level: 'high'
  },
  {
    label: 'Razorpay live key (not test)',
    check: () => !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_') || process.env.NODE_ENV !== 'production',
    pass:  'Razorpay key is live key',
    fail:  'RAZORPAY_KEY_ID is a test key (rzp_test_...) — use live key in production!',
    level: 'critical'
  }
];

// ── RUN CHECKS ─────────────────────────────────────────────────────────────

console.log(`\n${BOLD}${CYAN}╔═══════════════════════════════════════════╗`);
console.log(`║  MediCare Hospital — Environment Check    ║`);
console.log(`╚═══════════════════════════════════════════╝${RESET}\n`);

let criticalMissing = 0;
let highMissing     = 0;
let warnings        = 0;

console.log(`${BOLD}── Environment Variables ───────────────────────────────────────${RESET}`);

const levelIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };
const levelColor = { critical: RED, high: YELLOW, medium: YELLOW, low: RESET };

CHECKS.forEach(({ key, level, hint }) => {
  const val = process.env[key];
  if (val && val.trim()) {
    const preview = val.length > 30 ? val.slice(0, 12) + '...' + val.slice(-4) : val;
    console.log(`  ${GREEN}✓${RESET} ${key.padEnd(35)} ${levelIcon[level]} ${GREEN}Set${RESET} (${preview})`);
  } else {
    console.log(`  ${levelColor[level]}✗${RESET} ${key.padEnd(35)} ${levelIcon[level]} ${levelColor[level]}MISSING${RESET}`);
    console.log(`      ${CYAN}→ ${hint}${RESET}`);
    if (level === 'critical') criticalMissing++;
    else if (level === 'high') highMissing++;
    else warnings++;
  }
});

console.log(`\n${BOLD}── Security Checks ─────────────────────────────────────────────${RESET}`);

let securityFails = 0;
SECURITY.forEach(({ label, check, pass, fail, level }) => {
  try {
    const ok = check();
    if (ok) {
      console.log(`  ${GREEN}✓${RESET} ${pass}`);
    } else {
      console.log(`  ${levelColor[level]}✗${RESET} ${fail}`);
      if (level === 'critical') { criticalMissing++; securityFails++; }
      else if (level === 'high') { highMissing++; securityFails++; }
      else warnings++;
    }
  } catch(e) {
    console.log(`  ${YELLOW}?${RESET} ${label}: Could not check (${e.message})`);
  }
});

// ── MSG91 alternative ───────────────────────────────────────────────────────
if (process.env.USE_MSG91 === 'true') {
  const msg91Key = process.env.MSG91_AUTH_KEY;
  if (msg91Key) {
    console.log(`  ${GREEN}✓${RESET} MSG91_AUTH_KEY set (using MSG91 instead of Twilio)`);
  } else {
    console.log(`  ${YELLOW}✗${RESET} USE_MSG91=true but MSG91_AUTH_KEY is not set`);
    warnings++;
  }
}

// ── SUMMARY ────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Summary ─────────────────────────────────────────────────────${RESET}`);

if (criticalMissing === 0 && highMissing === 0) {
  console.log(`  ${GREEN}${BOLD}✅ All critical and high-priority checks passed!${RESET}`);
} else {
  if (criticalMissing > 0) {
    console.log(`  ${RED}${BOLD}❌ ${criticalMissing} CRITICAL issue(s) — server should NOT start${RESET}`);
  }
  if (highMissing > 0) {
    console.log(`  ${YELLOW}⚠️  ${highMissing} HIGH issue(s) — some features will not work${RESET}`);
  }
}
if (warnings > 0) {
  console.log(`  ${YELLOW}ℹ️  ${warnings} warning(s) — minor features may be disabled${RESET}`);
}

const nodeVer = parseInt(process.version.replace('v','').split('.')[0]);
if (nodeVer < 18) {
  console.log(`  ${RED}❌ Node.js version ${process.version} is below minimum (v18)${RESET}`);
  criticalMissing++;
} else {
  console.log(`  ${GREEN}✓${RESET} Node.js ${process.version} (≥18 required)`);
}

console.log('');

if (criticalMissing > 0) {
  console.log(`${RED}${BOLD}Server startup BLOCKED due to ${criticalMissing} critical issue(s).${RESET}`);
  console.log(`${RED}Fix the issues above, then restart.${RESET}\n`);
  process.exit(1);
} else {
  console.log(`${GREEN}${BOLD}Environment OK — safe to start the server.${RESET}\n`);
  process.exit(0);
}
