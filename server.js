require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { q, init } = require('./db');
const ps = require('./paystack');
const { BOTH_LEGS, ONE_LEG, DECAY } = require('./commissions');
const { NETWORKS, now, balances, holdMs, completeSignup, processPayment, refundPayout, withdraw, downlines } = require('./core');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`)).replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PRICE = Math.round(Number(process.env.PRODUCT_PRICE_GHS || 50) * 100);
const PAYOUT_MIN = Math.round(Number(process.env.PAYOUT_MIN_GHS || 5) * 100);
const FEE = Math.round(Number(process.env.WITHDRAW_FEE_GHS ?? 1) * 100); // Paystack charges GH₵1 per mobile money transfer; passed on to the member
const REQUIRE_REF = process.env.REQUIRE_REFERRAL !== 'false';

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

/* ---------- auth helpers ---------- */
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function signToken(id) {
  const p = Buffer.from(JSON.stringify({ id, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + hmac(p);
}
function readToken(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = hmac(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d.id : null; }
  catch { return null; }
}
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(h, 'hex'));
}
// Best-effort per-instance limiter (serverless instances do not share memory). Withdrawals use a database limit instead.
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.path, n = Date.now();
  const a = (hits.get(k) || []).filter((t) => n - t < windowMs);
  if (a.length >= max) return bad(res, 'Too many attempts. Try again later.', 429);
  a.push(n); hits.set(k, a); next();
};
const auth = (req, res, next) => {
  (async () => {
    const id = readToken((req.headers.authorization || '').replace('Bearer ', ''));
    const m = id && (await q('SELECT * FROM members WHERE id=$1', [id])).rows[0];
    if (!m) return bad(res, 'Please log in again.', 401);
    req.member = m; next();
  })().catch((e) => { console.error(e); bad(res, 'Something went wrong. Please try again.', 500); });
};
function adminAuth(req, res, next) {
  const k = String(req.headers['x-admin-key'] || '');
  if (!ADMIN_KEY || k.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY))) return bad(res, 'Forbidden', 403);
  next();
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Make sure the app is configured and the tables exist before handling any API request.
app.use('/api', (req, res, next) => {
  if (SECRET.length < 16) return bad(res, 'Server is not configured: set SESSION_SECRET (16+ characters).', 500);
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return bad(res, 'Server is not configured: set DATABASE_URL.', 500);
  init().then(() => next()).catch((e) => { console.error('db init failed', e.message); bad(res, 'Database is not ready.', 500); });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/config', (_, res) => res.json({ price: PRICE }));

/* ---------- Paystack webhook ----------
   We never trust what the webhook says. It is only a nudge: we look the reference up in OUR database and then ask
   Paystack directly (with your secret key) what really happened. That is safe even though a serverless host does not
   give us the raw request body needed to check Paystack's signature. */
app.post('/api/paystack/webhook', wrap(async (req, res) => {
  const ev = req.body || {}, d = ev.data || {}, ref = String(d.reference || '');
  if (!ref) return res.sendStatus(200);
  if (ev.event === 'charge.success') {
    const known = (await q('SELECT 1 FROM signups WHERE reference=$1 UNION SELECT 1 FROM purchases WHERE reference=$1', [ref])).rows.length;
    if (known) {
      const v = await ps.verify(ref);
      if (v.status === 'success' && v.currency === 'GHS') await processPayment(ref, v.amount);
    }
  } else if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(ev.event)) {
    const p = (await q('SELECT * FROM payouts WHERE reference=$1', [ref])).rows[0];
    if (p) {
      const t = await ps.verifyTransfer(ref);
      if (t.status === 'success') await q("UPDATE payouts SET status='paid' WHERE id=$1 AND status='processing'", [p.id]);
      else if (['failed', 'reversed'].includes(t.status)) await refundPayout(p.id);
    }
  }
  res.sendStatus(200);
}));

/* ---------- accounts ---------- */
app.post('/api/signup', limit(10, 600000), wrap(async (req, res) => {
  const { name, email, phone, password, network, ref, side } = req.body || {};
  if (!name || name.trim().length < 2) return bad(res, 'Enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 'Enter a valid email.');
  if (!/^0\d{9}$/.test(phone || '')) return bad(res, 'Enter a Ghana number like 0551234567.');
  if (!NETWORKS[network]) return bad(res, 'Choose your mobile money network.');
  if (!password || password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if ((await q('SELECT 1 FROM members WHERE phone=$1', [phone])).rows.length) return bad(res, 'That phone number is already registered.');
  let sponsor = null;
  if (ref) {
    sponsor = (await q('SELECT id FROM members WHERE code=$1', [String(ref).toUpperCase()])).rows[0];
    if (!sponsor) return bad(res, 'Invalid referral code.');
    if (side !== 'L' && side !== 'R') return bad(res, 'Choose Left or Right.');
  } else if (REQUIRE_REF && (await q('SELECT COUNT(*)::int AS c FROM members')).rows[0].c > 0) {
    return bad(res, 'A referral code is required to join.');
  }
  // Nothing is created yet. The sign-up details are saved, and the member pays first.
  // The account is only created once Paystack confirms the payment (see completeSignup in core.js).
  const reference = 'rs' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
  await q(`INSERT INTO signups(reference,name,email,phone,network,pass_hash,ref_code,side,amount,status,created)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [reference, name.trim(), email.trim(), phone, network, hashPw(password), sponsor ? String(ref).toUpperCase() : null, sponsor ? side : null, PRICE, 'pending', now()]);
  const d = await ps.initialize({
    email: email.trim(), amount: PRICE, currency: 'GHS', reference,
    callback_url: BASE_URL + '/', metadata: { type: 'signup', phone },
  });
  res.json({ url: d.authorization_url });
}));

// Called when the customer returns from Paystack after paying to sign up. Verifies the payment with Paystack
// and creates the account if the webhook has not already done so.
app.get('/api/signup/complete', limit(30, 600000), wrap(async (req, res) => {
  const reference = String(req.query.reference || '');
  const s = (await q('SELECT status FROM signups WHERE reference=$1', [reference])).rows[0];
  if (!s) return bad(res, 'Unknown signup.', 404);
  if (s.status !== 'completed') {
    const d = await ps.verify(reference);
    if (d.status !== 'success' || d.currency !== 'GHS') return bad(res, 'Payment was not completed. Please try again.', 402);
    const r = await completeSignup(reference, d.amount);
    if (!r.ok) return bad(res, r.reason === 'conflict'
      ? 'That phone number was registered while you were paying. Please contact support for a refund.'
      : 'Payment could not be confirmed.', 409);
  }
  res.json({ ok: true });
}));

app.post('/api/login', limit(15, 600000), wrap(async (req, res) => {
  const { phone, password } = req.body || {};
  const m = (await q('SELECT * FROM members WHERE phone=$1', [String(phone || '')])).rows[0];
  if (!m || !checkPw(String(password || ''), m.pass_hash)) return bad(res, 'Wrong phone number or password.', 401);
  res.json({ token: signToken(m.id) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const m = req.member;
  const [balance, dl, history, payouts] = await Promise.all([
    balances(m.id),
    downlines(m.id),
    q(`SELECT l.kind,l.amount,l.level,l.created,s.name AS src FROM ledger l
       LEFT JOIN members s ON s.id=l.src_id WHERE l.member_id=$1 ORDER BY l.id DESC LIMIT 100`, [m.id]),
    q('SELECT id,amount,fee,status,created FROM payouts WHERE member_id=$1 ORDER BY id DESC LIMIT 20', [m.id]),
  ]);
  res.json({
    name: m.name, code: m.code, active: !!m.active, balance: balance.available, pendingAmount: balance.pending, holdHours: holdMs() / 3600e3,
    price: PRICE, payoutMin: PAYOUT_MIN, fee: FEE, rewards: { both: BOTH_LEGS, one: ONE_LEG, decay: DECAY },
    downlines: dl, history: history.rows, payouts: payouts.rows,
  });
}));

/* ---------- payments ---------- */
app.post('/api/checkout', auth, wrap(async (req, res) => {
  const reference = 'rp' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  await q('INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,$3,$4,$5)', [req.member.id, reference, PRICE, 'pending', now()]);
  const d = await ps.initialize({
    email: req.member.email, amount: PRICE, currency: 'GHS', reference,
    callback_url: BASE_URL + '/', metadata: { member_id: req.member.id },
  });
  res.json({ url: d.authorization_url });
}));

app.get('/api/verify', auth, wrap(async (req, res) => {
  const reference = String(req.query.reference || '');
  const p = (await q('SELECT * FROM purchases WHERE reference=$1 AND member_id=$2', [reference, req.member.id])).rows[0];
  if (!p) return bad(res, 'Unknown payment.', 404);
  const d = await ps.verify(reference);
  if (d.status === 'success' && d.currency === 'GHS') await processPayment(reference, d.amount);
  res.json({ status: (await q('SELECT status FROM purchases WHERE id=$1', [p.id])).rows[0].status });
}));

/* ---------- withdrawals (instant, from your Paystack balance) ---------- */
app.post('/api/payout', auth, wrap(async (req, res) => {
  const recent = (await q('SELECT COUNT(*)::int AS c FROM payouts WHERE member_id=$1 AND created > $2',
    [req.member.id, new Date(Date.now() - 3600e3).toISOString()])).rows[0].c;
  if (recent >= 10) return bad(res, 'Too many withdrawals this hour. Please try again later.', 429);
  const gross = Math.round(Number((req.body || {}).amount) * 100);
  const r = await withdraw(req.member.id, gross, { ps, fee: FEE, min: PAYOUT_MIN });
  if (r.code === 'min') return bad(res, `Minimum withdrawal is GH₵${PAYOUT_MIN / 100}.`);
  if (r.code === 'balance') return bad(res, 'Not enough balance.');
  if (r.code === 'pending') return bad(res, 'Your newest earnings can be withdrawn 24 hours after you earn them. Try a smaller amount or come back later.');
  if (!r.ok) return bad(res, 'Withdrawals are temporarily unavailable. Your balance is safe. Please try again later.', 503);
  res.json({ ok: true, id: r.id, status: r.status, received: gross - FEE });
}));

app.get('/api/admin/conflicts', adminAuth, wrap(async (req, res) => {
  res.json((await q("SELECT reference,name,phone,amount,created FROM signups WHERE status='conflict'")).rows);
}));

// Recent withdrawals, so you can watch for failures.
app.get('/api/admin/payouts', adminAuth, wrap(async (req, res) => {
  res.json((await q(`SELECT p.id,p.amount,p.fee,p.status,p.created,m.name,m.phone,m.network
    FROM payouts p JOIN members m ON m.id=p.member_id ORDER BY p.id DESC LIMIT 100`)).rows);
}));

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`ReferPay running on ${BASE_URL}`));
