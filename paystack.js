const crypto = require('crypto');
const key = () => process.env.PAYSTACK_SECRET_KEY || '';

async function api(method, path, body) {
  const r = await fetch('https://api.paystack.co' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) throw new Error(j.message || 'Paystack error ' + r.status);
  return j.data;
}

function validSignature(rawBody, signature) {
  if (!signature || !key()) return false;
  const expected = crypto.createHmac('sha512', key()).update(rawBody).digest('hex');
  return expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = {
  initialize: (b) => api('POST', '/transaction/initialize', b),
  verify: (ref) => api('GET', '/transaction/verify/' + encodeURIComponent(ref)),
  recipient: (b) => api('POST', '/transferrecipient', b),
  transfer: (b) => api('POST', '/transfer', b),
  verifyTransfer: (ref) => api('GET', '/transfer/verify/' + encodeURIComponent(ref)),
  validSignature,
};
