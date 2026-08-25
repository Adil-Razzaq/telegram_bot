const crypto = require('crypto');

function adminAuth(req, res, next) {
  const provided = req.header('x-admin-key');
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_API_KEY not set' });
  }
  if (!provided) {
    return res.status(401).json({ error: 'Missing x-admin-key header' });
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const same =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!same) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

module.exports = { adminAuth };
