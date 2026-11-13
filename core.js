const crypto = require('crypto');
const { q, tx } = require('./db');
const { MAX_LEVELS, plan } = require('./commissions');

const now = () => new Date().toISOString();
// Paystack Ghana mobile money codes. Confirm in the Paystack docs if a transfer is rejected.
const NETWORKS = { MTN: 'MTN', TELECEL: 'VOD', AIRTELTIGO: 'ATL' };
const ph = (n, off = 0) => Array.from({ length: n }, (_, i) => '$' + (i + 1 + off)).join(',');
const isUnique = (e) => !!e && (e.code === '23505' || /unique/i.test(e.message || ''));

// c is a query function: q (normal) or the one given by tx() (inside a transaction).
const balanceOf = async (id, c = q) =>
  (await c('SELECT COALESCE(SUM(amount),0)::int AS b FROM ledger WHERE member_id=$1', [id])).rows[0].b;

// New rewards can only be withdrawn after a waiting period (default 24 hours, set REWARD_HOLD_HOURS; 0 = no wait).
// This gives Paystack time to settle sign-up payments into your balance before members can take rewards out.
const holdMs = () => Number(process.env.REWARD_HOLD_HOURS ?? 24) * 3600e3;
// total = everything the member is owed, pending = rewards still inside the waiting period,
// available = what they can withdraw right now.
async function balances(id, c = q) {
  const cutoff = new Date(Date.now() - holdMs()).toISOString();
  const r = (await c(`SELECT COALESCE(SUM(amount),0)::int AS total,
      COALESCE(SUM(CASE WHEN kind='reward' AND created > $2 THEN amount ELSE 0 END),0)::int AS pending
    FROM ledger WHERE member_id=$1`, [id, cutoff])).rows[0];
  return { total: r.total, pending: r.pending, available: r.total - r.pending };
}

// Binary placement. The new member joins the sponsor's chosen side. If that spot is taken, they spill over
// to the first free spot further down that side (shallowest first, then oldest first).
async function place(c, sponsorId, side) {
  const first = (await c('SELECT id FROM members WHERE parent_id=$1 AND side=$2', [sponsorId, side])).rows[0];
  if (!first) return { parentId: sponsorId, side };
  const r = (await c(`
    WITH RECURSIVE s(id,depth) AS (
      SELECT id,0 FROM members WHERE parent_id=$1 AND side=$2
      UNION ALL SELECT m.id,s.depth+1 FROM members m JOIN s ON m.parent_id=s.id)
    SELECT s.id,
      EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='L') AS has_l
    FROM s
    WHERE NOT (EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='L')
           AND EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='R'))
    ORDER BY s.depth, s.id LIMIT 1`, [sponsorId, side])).rows[0];
  return { parentId: r.id, side: r.has_l ? 'R' : 'L' };
}

// Marks a purchase paid and, on the member's FIRST paid purchase, rewards everyone above them up to the top.
// Safe to call many times (webhook retries, return page): rewards are only created once.
async function fulfill(reference, amountPaid) {
  const p = (await q('SELECT * FROM purchases WHERE reference=$1', [reference])).rows[0];
  if (!p) return { ok: false, reason: 'unknown reference' };
  if (p.status === 'paid') return { ok: true, already: true };
  if (amountPaid < p.amount) return { ok: false, reason: 'amount too low' };
  await tx(async (c) => {
    const upd = await c("UPDATE purchases SET status='paid' WHERE id=$1 AND status='pending'", [p.id]);
    if (upd.rowCount !== 1) return;
    const prior = (await c("SELECT COUNT(*)::int AS n FROM purchases WHERE member_id=$1 AND status='paid' AND id<>$2", [p.member_id, p.id])).rows[0].n;
    await c('UPDATE members SET active=1 WHERE id=$1', [p.member_id]);
    if (prior > 0) return; // only the first purchase triggers rewards
    // Every member above the buyer, nearest first, in ONE query. path[0] is the buyer.
    const path = (await c(`
      WITH RECURSIVE up(id,parent_id,side,lvl) AS (
        SELECT id,parent_id,side,0 FROM members WHERE id=$1
        UNION ALL SELECT m.id,m.parent_id,m.side,up.lvl+1 FROM members m JOIN up ON m.id=up.parent_id WHERE up.lvl<$2)
      SELECT id,parent_id,side FROM up ORDER BY lvl`, [p.member_id, MAX_LEVELS])).rows;
    const anc = path.filter((r) => r.parent_id !== null).map((r) => ({ id: r.parent_id, side: r.side })); // side = buyer's side under that ancestor
    if (!anc.length) return;
    const ids = anc.map((a) => a.id);
    const counts = {};
    (await c(`SELECT id,left_active,right_active FROM members WHERE id IN (${ph(ids.length)})`, ids)).rows.forEach((r) => { counts[r.id] = r; });
    // "both sides" = the other side already has at least one active member
    const chain = anc.map((a) => ({ memberId: a.id, both: (a.side === 'L' ? counts[a.id].right_active : counts[a.id].left_active) > 0 }));
    const lefts = anc.filter((a) => a.side === 'L').map((a) => a.id);
    const rights = anc.filter((a) => a.side === 'R').map((a) => a.id);
    if (lefts.length) await c(`UPDATE members SET left_active=left_active+1 WHERE id IN (${ph(lefts.length)})`, lefts);
    if (rights.length) await c(`UPDATE members SET right_active=right_active+1 WHERE id IN (${ph(rights.length)})`, rights);
    const rows = plan(chain);
    const vals = [], params = [];
    rows.forEach((r, i) => {
      const o = i * 7;
      vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
      params.push(r.memberId, 'reward', r.amount, `reward:${p.id}:${r.level}`, p.member_id, r.level, now());
    });
    await c(`INSERT INTO ledger(member_id,kind,amount,ref,src_id,level,created) VALUES ${vals.join(',')} ON CONFLICT (ref) DO NOTHING`, params);
  });
  return { ok: true };
}

// Sign-up is paid BEFORE the account exists. The account is created here, only after Paystack confirms the payment.
// That payment is the member's first purchase, so it also rewards everyone above them. Safe to call repeatedly.
async function completeSignup(reference, amountPaid) {
  const s = (await q('SELECT * FROM signups WHERE reference=$1', [reference])).rows[0];
  if (!s) return { ok: false, reason: 'unknown reference' };
  if (amountPaid < s.amount) return { ok: false, reason: 'amount too low' };
  if (s.status === 'conflict') return { ok: false, reason: 'conflict' };
  if (s.status !== 'completed') {
    for (let attempt = 0; ; attempt++) {
      try {
        await tx(async (c) => {
          const lock = await c("UPDATE signups SET status='completed' WHERE id=$1 AND status='pending'", [s.id]);
          if (lock.rowCount !== 1) return;
          const sponsor = s.ref_code ? (await c('SELECT id FROM members WHERE code=$1', [s.ref_code])).rows[0] : null;
          const spot = sponsor ? await place(c, sponsor.id, s.side) : { parentId: null, side: null };
          let code;
          do { code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
          while ((await c('SELECT 1 FROM members WHERE code=$1', [code])).rows.length);
          const m = await c(`INSERT INTO members(name,email,phone,network,pass_hash,code,parent_id,sponsor_id,side,created)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [s.name, s.email, s.phone, s.network, s.pass_hash, code, spot.parentId, sponsor ? sponsor.id : null, spot.side, now()]);
          const memberId = m.rows[0].id;
          await c('UPDATE signups SET member_id=$1 WHERE id=$2', [memberId, s.id]);
          await c('INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,$3,$4,$5)', [memberId, reference, s.amount, 'pending', now()]);
        });
        break;
      } catch (e) {
        if (!isUnique(e)) throw e;
        const taken = (await q('SELECT 1 FROM members WHERE phone=$1', [s.phone])).rows.length;
        if (taken) {
          // Someone registered this phone number while this payment was in progress. Needs a manual refund.
          await q("UPDATE signups SET status='conflict' WHERE id=$1", [s.id]);
          console.error('SIGNUP CONFLICT, refund needed for payment', reference);
          return { ok: false, reason: 'conflict' };
        }
        if (attempt >= 4) throw e; // otherwise two people grabbed the same tree spot at once: try again
      }
    }
  }
  return fulfill(reference, amountPaid); // activates the member and pays the levels above (idempotent)
}

// Routes a confirmed payment to the right handler: a new sign-up, or a purchase by an existing member.
async function processPayment(reference, amountPaid) {
  if ((await q('SELECT 1 FROM signups WHERE reference=$1', [reference])).rows.length) return completeSignup(reference, amountPaid);
  return fulfill(reference, amountPaid);
}

// Returns a failed withdrawal's money to the member's balance (only once, and never for a withdrawal that was paid).
async function refundPayout(id) {
  const p = (await q('SELECT * FROM payouts WHERE id=$1', [id])).rows[0];
  if (!p || p.status === 'paid') return;
  await q("UPDATE payouts SET status='failed' WHERE id=$1 AND status IN ('processing','pending')", [id]);
  await q('INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,$2,$3,$4,$5) ON CONFLICT (ref) DO NOTHING',
    [p.member_id, 'payout_refund', p.amount, 'refund:' + id, now()]);
}

// Instant withdrawal to the member's mobile money, straight from the Paystack balance.
// The amount is taken off the member's balance FIRST (the member row is locked, so two clicks can never spend
// it twice), then the transfer is sent. If Paystack definitely did not accept it, the money goes back.
// If it is unclear (e.g. a network error after sending), nothing is refunded and the Paystack webhook decides.
async function withdraw(memberId, gross, { ps, fee, min }) {
  if (!Number.isInteger(gross) || gross < min || gross - fee < 100) return { ok: false, code: 'min' };
  const reference = 'rp_payout_' + crypto.randomBytes(8).toString('hex');
  const got = await tx(async (c) => {
    await c('SELECT id FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    const b = await balances(memberId, c);
    if (b.available < gross) return { code: b.total >= gross ? 'pending' : 'balance' }; // 'pending' = still in the waiting period
    const r = await c('INSERT INTO payouts(member_id,amount,fee,status,reference,created) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [memberId, gross, fee, 'processing', reference, now()]);
    const pid = r.rows[0].id;
    await c('INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,$2,$3,$4,$5)', [memberId, 'payout_hold', -gross, 'hold:' + pid, now()]);
    return { id: pid };
  });
  if (!got.id) return { ok: false, code: got.code };
  const id = got.id;
  const m = (await q('SELECT * FROM members WHERE id=$1', [memberId])).rows[0];
  try {
    let code = m.recipient_code;
    if (!code) {
      const rec = await ps.recipient({ type: 'mobile_money', name: m.name, account_number: m.phone, bank_code: NETWORKS[m.network], currency: 'GHS' });
      code = rec.recipient_code;
      await q('UPDATE members SET recipient_code=$1 WHERE id=$2', [code, memberId]);
    }
    const t = await ps.transfer({ source: 'balance', amount: gross - fee, recipient: code, reference, reason: 'ReferPay withdrawal', currency: 'GHS' });
    if (t.status === 'otp') throw new Error('Paystack wants an OTP. Turn off "Confirm transfers before sending" in Paystack Preferences.');
    if (t.status === 'success') await q("UPDATE payouts SET status='paid' WHERE id=$1", [id]);
    return { ok: true, id, status: t.status };
  } catch (e) {
    console.error('withdrawal error:', e.message);
    let known = null;
    try { known = await ps.verifyTransfer(reference); } catch (_) { /* Paystack has no such transfer */ }
    if (known && ['success', 'pending', 'processing', 'received'].includes(known.status)) return { ok: true, id, status: known.status };
    await refundPayout(id);
    return { ok: false, code: 'unavailable' };
  }
}

// Everyone below a member at any depth, combined, with which side (leg) they are on, whether the member
// sponsored them directly, and how much the member earned from them.
async function downlines(id) {
  return (await q(`
    WITH RECURSIVE d(id,name,active,lvl,leg,direct) AS (
      SELECT id,name,active,1,side,(sponsor_id=$1) FROM members WHERE parent_id=$1
      UNION ALL SELECT m.id,m.name,m.active,d.lvl+1,d.leg,(m.sponsor_id=$1) FROM members m JOIN d ON m.parent_id=d.id)
    SELECT d.*, COALESCE((SELECT SUM(amount) FROM ledger WHERE member_id=$1 AND src_id=d.id AND kind='reward'),0)::int AS earned
    FROM d ORDER BY leg,lvl,name`, [id])).rows;
}

module.exports = { NETWORKS, now, balanceOf, balances, holdMs, place, fulfill, completeSignup, processPayment, refundPayout, withdraw, downlines };
