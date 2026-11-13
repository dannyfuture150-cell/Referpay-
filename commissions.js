// Binary reward plan. All amounts are in pesewas (100 pesewas = GH₵1).
// Every member has a LEFT and a RIGHT side. When someone makes their first purchase, EVERY member above
// them (all the way to the top) is rewarded:
//   - GH₵10 if the member has active people on BOTH sides (left and right)
//   - GH₵5  if only ONE side has active people
// The reward is for the member directly above the buyer (level 1). Each level further up earns half of
// the level below it, but never less than 1 pesewa, so everyone up to the top gets something.
const BOTH_LEGS = 1000;
const ONE_LEG = 500;
const DECAY = 0.5;
const MIN_AMOUNT = 1;
const MAX_LEVELS = Number(process.env.REWARD_MAX_LEVELS || 1000); // safety limit on how far up we go

function amountFor(level, bothLegs) {
  const base = bothLegs ? BOTH_LEGS : ONE_LEG;
  return Math.max(MIN_AMOUNT, Math.floor(base * Math.pow(DECAY, level - 1)));
}

// chain = ancestors from the buyer upward: [{ memberId, both }]
function plan(chain) {
  return chain.slice(0, MAX_LEVELS).map((c, i) => ({
    memberId: c.memberId, level: i + 1, both: !!c.both, amount: amountFor(i + 1, c.both),
  }));
}
module.exports = { BOTH_LEGS, ONE_LEG, DECAY, MIN_AMOUNT, MAX_LEVELS, amountFor, plan };
