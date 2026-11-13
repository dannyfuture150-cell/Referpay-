# ReferPay (Node.js + Postgres + Paystack, Ghana) for free Render + Neon

Binary (left/right) referral platform. A new member **pays GH₵50 first** (mobile money or card, via Paystack).
Their account is created only after Paystack confirms the payment, and that payment is their first purchase, so it
rewards everyone above them, all the way to the top:

- **GH₵10** if the member has active people on **both** sides (left and right), **GH₵5** if only **one** side.
- The reward is for the member directly above the buyer. **Each level further up earns half** of the level below,
  never less than GH₵0.01.

Members see all their downlines combined. New earnings can be **withdrawn 24 hours after they are earned** (set
`REWARD_HOLD_HOURS`, 0 = no wait). After that they can **withdraw any amount (from GH₵5) at any time** to their
mobile money, straight from your Paystack balance. The waiting period gives Paystack time to settle sign-up
payments into your balance before rewards leave it. Rewards are paid on real product purchases, never on sign-ups alone.

## Read this first: the free setup is for TESTING
- **Render's free web service goes to sleep** after about 15 minutes with no visitors and takes about a minute to wake.
  Paystack confirmations can then arrive late (the sign-up return page still completes sign-ups).
- Check Render's and Neon's current terms and limits before using free plans for a paid business.
- Move to a paid always-on plan before real members' money is involved.

## 1. Create the free database (Neon)
1. Sign up at neon.tech and create a project. Copy the **pooled** connection string (it starts with `postgres://`).
2. Keep it secret. This is your `DATABASE_URL`. The tables are created automatically on the first request.

## 2. Deploy on Render
1. Unzip this project and upload it to a **GitHub** repository (do not upload a `.env` file).
2. On render.com choose **New, Blueprint** and pick the repo (it reads `render.yaml`), or choose **New, Web Service**
   and set: Runtime Node, Build `npm install`, Start `npm start`, Instance type **Free**.
3. Set these environment variables:
   - `DATABASE_URL`: your Neon string
   - `PAYSTACK_SECRET_KEY`: your `sk_test_...` key
   - `SESSION_SECRET` and `ADMIN_KEY`: long random strings (the Blueprint generates them; view them in the Environment tab)
   - `NODE_VERSION`: `20`
   - optional: `REWARD_HOLD_HOURS`, `PRODUCT_PRICE_GHS`, `PAYOUT_MIN_GHS`, `WITHDRAW_FEE_GHS`, `REQUIRE_REFERRAL`, `REWARD_MAX_LEVELS`
4. When Render gives you your address (like `https://referpay.onrender.com`), you do not need to set `BASE_URL`
   (the app reads Render's address), but you can set it if you use your own domain.
5. Open your address. Sign up the **first member** without a referral code (this member is the top of your tree).
   After that, everyone needs a referral code.

## 3. Paystack settings
1. Settings, API Keys & Webhooks: set the webhook URL to `https://YOUR-ADDRESS/api/paystack/webhook`.
2. Enable **Transfers**, turn on **Manual Payouts** (so collected money stays in your Paystack Balance), and turn
   **off** "Confirm transfers before sending" (the transfer OTP), or every withdrawal will fail.
3. Keep enough in your Paystack Balance to cover what members are owed. Confirm Paystack's current settlement
   rules with them. Never spend money members can still withdraw.
4. Switch from `sk_test_...` to your live key only after testing a full sign-up and a withdrawal in test mode.

## 4. How it stays safe
- **The webhook is never trusted.** It only tells the server a payment happened. The server then asks Paystack
  directly (with your secret key) whether it really succeeded, and for the real amount.
- **Money is a ledger in Postgres** (`ledger` table, in pesewas). A withdrawal locks the member's row, takes the
  money off their balance first, then sends the transfer. If Paystack refuses, the money goes back automatically.
  Two quick taps can't spend the same balance twice.
- Everything is safe to run twice (webhook retries, the return page): rewards are created only once.
- Withdrawals are limited to 10 per member per hour.
- Watch for problems: `curl -H "x-admin-key: YOUR_ADMIN_KEY" https://YOUR-ADDRESS/api/admin/payouts`
  and `/api/admin/conflicts` (two people who paid to register the same phone number; refund the second in Paystack).

## 5. Change the rewards
Edit `commissions.js`: `BOTH_LEGS` and `ONE_LEG` (pesewas, 1000 = GH₵10), `DECAY` (0.5 = halves per level),
`MIN_AMOUNT`. Product price: `PRODUCT_PRICE_GHS`.

**Check your margins.** With the defaults, one GH₵50 sale pays up to about GH₵20 across the first eleven levels
above the buyer (GH₵19.97 when every level has both sides), plus GH₵0.01 per level beyond that. Paystack takes
about GH₵1 as well. A very deep chain adds more, so consider a smaller `REWARD_MAX_LEVELS` (for example 20).

## 6. Run the tests
`npm install`, then create a SEPARATE empty Postgres database (a Neon branch works) and run:
`TEST_DATABASE_URL=postgres://... npm test`. The tests wipe that database, so never use your live one.

## 7. Before you launch
- Test everything in Paystack test mode first, including a withdrawal. Confirm the mobile money network codes
  (`MTN`, `VOD`, `ATL`) in `core.js` against Paystack's docs.
- Paystack's rules list some multi-level marketing and matrix programs as ineligible businesses. Be open with them
  about how the plan works, sell a real product, and get a Ghanaian lawyer to review it. Do not promise income.
- Add a privacy policy and terms, and keep database backups.
