const assert = require('assert');
const { plan, amountFor } = require('./commissions');

// 1. Pure reward-plan checks (always run)
assert.strictEqual(amountFor(1, true), 1000);   // both sides, directly above: GH₵10
assert.strictEqual(amountFor(1, false), 500);   // one side, directly above: GH₵5
assert.strictEqual(amountFor(2, true), 500);    // halves each level up
assert.strictEqual(amountFor(40, false), 1);    // never below 1 pesewa, so it reaches the top
assert.strictEqual(plan([{ memberId: 1, both: true }, { memberId: 2, both: false }]).length, 2);
console.log('reward plan tests passed');

// 2. Database tests. They need a SEPARATE, EMPTY Postgres database and WIPE it, so never point this at your live one.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) { console.log('Skipping database tests. To run them: TEST_DATABASE_URL=<a separate empty test database> npm test'); process.exit(0); }
if (testUrl === process.env.DATABASE_URL) { console.error('TEST_DATABASE_URL must not be your live DATABASE_URL.'); process.exit(1); }
process.env.DATABASE_URL = testUrl;

const { q, tx, init, pool } = require('./db');
const { balances } = require('./core');
const { fulfill, balanceOf, downlines, refundPayout, place, completeSignup, processPayment, withdraw } = require('./core');

(async () => {
  process.env.REWARD_HOLD_HOURS = '0'; // the main scenarios below ignore the waiting period; it is tested separately at the end
  await init();
  await q('TRUNCATE payouts, ledger, purchases, signups, members RESTART IDENTITY CASCADE');
  let n = 0, ref = 0;
  const mk = async (name, sponsor, side) => {
    const spot = sponsor ? await place(q, sponsor, side) : { parentId: null, side: null };
    return (await q(`INSERT INTO members(name,email,phone,network,pass_hash,code,parent_id,sponsor_id,side,created)
      VALUES($1,$2,$3,'MTN','x',$4,$5,$6,$7,'now') RETURNING id`, [name, name + '@x.com', '0' + (500000000 + ++n), name + n, spot.parentId, sponsor, spot.side])).rows[0].id;
  };
  const buy = async (m) => {
    const r = 'r' + ++ref;
    await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,5000,'pending','now')", [m, r]);
    return fulfill(r, 5000);
  };
  const at = async (id) => (await q('SELECT parent_id AS p, side AS s FROM members WHERE id=$1', [id])).rows[0];

  // Placement and spillover
  const A = await mk('A', null), B = await mk('B', A, 'L'), C = await mk('C', A, 'R');
  const D = await mk('D', A, 'L'), E = await mk('E', A, 'L'), F = await mk('F', A, 'L');
  assert.deepStrictEqual([(await at(B)).p, (await at(B)).s], [A, 'L']);
  assert.deepStrictEqual([(await at(C)).p, (await at(C)).s], [A, 'R']);
  assert.deepStrictEqual([(await at(D)).p, (await at(D)).s], [B, 'L']);  // A's left is full, D spills under B
  assert.deepStrictEqual([(await at(E)).p, (await at(E)).s], [B, 'R']);
  assert.deepStrictEqual([(await at(F)).p, (await at(F)).s], [D, 'L']);

  // Rewards: one side vs both sides
  await buy(B);
  assert.strictEqual(await balanceOf(A), 500);                  // A has only a left side so far: GH₵5
  await buy(C);
  assert.strictEqual(await balanceOf(A), 500 + 1000);           // now both sides: +GH₵10
  await buy(D);                                                  // D is under B (level 1) and A (level 2)
  assert.strictEqual(await balanceOf(B), 500);                  // B has one side only: GH₵5
  assert.strictEqual(await balanceOf(A), 1500 + 500);           // A has both sides, level 2: half of GH₵10
  await buy(E);                                                  // B now has both sides
  assert.strictEqual(await balanceOf(B), 500 + 1000);
  assert.strictEqual(await balanceOf(A), 2000 + 500);
  assert.strictEqual((await fulfill('r4', 5000)).already, true); // a webhook retry of the same payment does nothing
  assert.strictEqual(await balanceOf(A), 2500);
  const before = await balanceOf(B);
  await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,'again',5000,'pending','now')", [E]);
  await fulfill('again', 5000);                                  // a second purchase by the same member pays nothing
  assert.strictEqual(await balanceOf(B), before);
  assert.strictEqual((await fulfill('nope', 5000)).ok, false);
  await q("INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,'low',5000,'pending','now')", [F]);
  assert.strictEqual((await fulfill('low', 4000)).ok, false);   // underpaid is rejected

  // Downlines combined, with sides
  const dl = await downlines(A);
  assert.strictEqual(dl.length, 5);
  assert.strictEqual(dl.filter((d) => d.leg === 'L').length, 4);
  assert.strictEqual(dl.filter((d) => d.leg === 'R').length, 1);
  assert.ok(dl.find((d) => d.name === 'D').direct);              // A sponsored D even though D sits under B
  assert.ok(!(await downlines(B)).find((d) => d.name === 'D').direct);

  // A long chain: everyone up to the very top gets paid
  const top = await mk('TOP', null);
  let prev = top; for (let i = 0; i < 40; i++) prev = await mk('N' + i, prev, 'L');
  await buy(prev);
  assert.strictEqual(await balanceOf(top), 1);                   // 40 levels up: minimum 1 pesewa, but still paid
  assert.strictEqual((await q("SELECT COUNT(*)::int AS c FROM ledger WHERE kind='reward' AND src_id=$1", [prev])).rows[0].c, 40);

  // Pay-to-sign-up: nothing exists until the payment is confirmed
  const su = (r, name, phone, code, side) => q(`INSERT INTO signups(reference,name,email,phone,network,pass_hash,ref_code,side,amount,status,created)
    VALUES($1,$2,$3,$4,'MTN','hash',$5,$6,5000,'pending','now')`, [r, name, name + '@x.com', phone, code, side]);
  const codeOf = async (id) => (await q('SELECT code FROM members WHERE id=$1', [id])).rows[0].code;
  const hasPhone = async (p) => (await q('SELECT 1 FROM members WHERE phone=$1', [p])).rows.length > 0;
  await su('s1', 'Newbie', '0244000001', await codeOf(C), 'R');
  assert.strictEqual(await hasPhone('0244000001'), false);
  assert.strictEqual((await completeSignup('s1', 4000)).ok, false);   // underpaid: still no account
  assert.strictEqual(await hasPhone('0244000001'), false);
  const cBefore = await balanceOf(C), aBefore = await balanceOf(A);
  assert.strictEqual((await processPayment('s1', 5000)).ok, true);
  const nb = (await q("SELECT * FROM members WHERE phone='0244000001'")).rows[0];
  assert.strictEqual(nb.active, 1);
  assert.deepStrictEqual([nb.parent_id, nb.side, nb.sponsor_id], [C, 'R', C]);
  assert.strictEqual((await balanceOf(C)) - cBefore, 500);            // level 1: C has people on one side only -> GH₵5
  assert.strictEqual((await balanceOf(A)) - aBefore, 500);            // level 2: A has both sides -> GH₵10 halved
  assert.strictEqual((await completeSignup('s1', 5000)).ok, true);    // return-page retry: nothing doubles
  assert.strictEqual((await q("SELECT COUNT(*)::int AS c FROM members WHERE phone='0244000001'")).rows[0].c, 1);
  assert.strictEqual((await balanceOf(C)) - cBefore, 500);
  await su('s2', 'Twin', '0244000001', await codeOf(C), 'R');
  assert.strictEqual((await completeSignup('s2', 5000)).reason, 'conflict');
  assert.strictEqual((await q("SELECT status FROM signups WHERE reference='s2'")).rows[0].status, 'conflict');
  // two people paying at the same moment both get an account, in different spots
  await su('s3', 'P3', '0244000003', await codeOf(C), 'L'); await su('s4', 'P4', '0244000004', await codeOf(C), 'L');
  const both = await Promise.all([completeSignup('s3', 5000), completeSignup('s4', 5000)]);
  assert.ok(both.every((r) => r.ok));
  const spots = (await q("SELECT parent_id, side FROM members WHERE phone IN ('0244000003','0244000004')")).rows.map((r) => r.parent_id + r.side);
  assert.strictEqual(new Set(spots).size, 2);

  // Payout hold + refund keeps balances whole, and never refunds a paid withdrawal
  await q("INSERT INTO payouts(member_id,amount,status,created) VALUES($1,1000,'processing','now')", [B]);
  const pid = (await q('SELECT MAX(id)::int AS id FROM payouts')).rows[0].id;
  await q("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'payout_hold',-1000,$2,'now')", [B, 'hold:' + pid]);
  const mid = await balanceOf(B); await refundPayout(pid); await refundPayout(pid);
  assert.strictEqual(await balanceOf(B), mid + 1000);
  await q("INSERT INTO payouts(member_id,amount,status,created) VALUES($1,1000,'paid','now')", [B]);
  const paidId = (await q('SELECT MAX(id)::int AS id FROM payouts')).rows[0].id;
  const b2 = await balanceOf(B); await refundPayout(paidId);
  assert.strictEqual(await balanceOf(B), b2);

  // Instant withdrawals (Paystack is faked here)
  const opts = (ps) => ({ ps, fee: 100, min: 500 });
  let recipients = 0; const sent = [];
  const okPs = { recipient: async () => { recipients++; return { recipient_code: 'RCP_1' }; },
    transfer: async (b) => { sent.push(b); return { status: 'success' }; }, verifyTransfer: async () => { throw new Error('not found'); } };
  const start = await balanceOf(A);
  assert.strictEqual((await withdraw(A, 300, opts(okPs))).code, 'min');
  assert.strictEqual((await withdraw(A, start + 100, opts(okPs))).code, 'balance');
  const w1 = await withdraw(A, 500, opts(okPs));
  assert.strictEqual(w1.ok, true);
  assert.strictEqual(await balanceOf(A), start - 500);
  assert.strictEqual(sent[0].amount, 400);                                          // GH₵5 minus the GH₵1 fee is sent
  assert.strictEqual((await q('SELECT status FROM payouts WHERE id=$1', [w1.id])).rows[0].status, 'paid');
  await withdraw(A, 500, opts(okPs));
  assert.strictEqual(recipients, 1);                                                // recipient is created once and reused
  const afterOk = await balanceOf(A);
  const failPs = { ...okPs, transfer: async () => { throw new Error('insufficient balance'); } };
  assert.strictEqual((await withdraw(A, 500, opts(failPs))).ok, false);             // Paystack refuses: money comes back
  assert.strictEqual(await balanceOf(A), afterOk);
  const otpPs = { ...okPs, transfer: async () => ({ status: 'otp' }) };
  assert.strictEqual((await withdraw(A, 500, opts(otpPs))).ok, false);
  assert.strictEqual(await balanceOf(A), afterOk);
  const unsurePs = { ...okPs, transfer: async () => { throw new Error('network'); }, verifyTransfer: async () => ({ status: 'pending' }) };
  assert.strictEqual((await withdraw(A, 500, opts(unsurePs))).ok, true);            // may have been sent: NOT refunded
  const afterUnsure = await balanceOf(A);
  assert.strictEqual(afterUnsure, afterOk - 500);
  const [x, y] = await Promise.all([withdraw(A, afterUnsure, opts(okPs)), withdraw(A, afterUnsure, opts(okPs))]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1);                         // two clicks can only spend it once
  assert.strictEqual(await balanceOf(A), 0);

  // Next-day rule: new rewards cannot be withdrawn until the waiting period has passed
  process.env.REWARD_HOLD_HOURS = '24';
  const G = await mk('G', null), H = await mk('H', G, 'L');
  await buy(H);                                                    // G earns GH₵5 right now
  let b = await balances(G);
  assert.deepStrictEqual([b.total, b.pending, b.available], [500, 500, 0]);
  assert.strictEqual((await withdraw(G, 500, opts(okPs))).code, 'pending');       // too soon
  assert.strictEqual(await balanceOf(G), 500);                                     // nothing was taken
  await q("UPDATE ledger SET created='2020-01-01T00:00:00.000Z' WHERE member_id=$1 AND kind='reward'", [G]); // pretend it was earned long ago
  b = await balances(G);
  assert.deepStrictEqual([b.total, b.pending, b.available], [500, 0, 500]);
  assert.strictEqual((await withdraw(G, 500, opts(okPs))).ok, true);               // now it can go
  assert.strictEqual(await balanceOf(G), 0);
  process.env.REWARD_HOLD_HOURS = '0';

  console.log('All database tests passed');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
