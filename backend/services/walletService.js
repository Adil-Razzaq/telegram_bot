const { client } = require('../db/db');

const BEP20_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Connects a wallet address to this Telegram account. First account to
 * claim a given address owns it permanently — a different account trying
 * to claim the same address is rejected, not merged. This is what stops
 * someone farming multiple fresh Telegram accounts (each with its own
 * referral bonus, task claims, daily caps) and then pooling all of it
 * into one wallet.
 *
 * Race-safety: rather than SELECT-then-UPDATE (which has a window where
 * two simultaneous requests could both pass the check), this relies on
 * the database's own unique index (idx_users_wallet_address in
 * schema.sql) — the UPDATE either succeeds or fails a real constraint,
 * with no gap for a race to slip through.
 */
async function connectWallet({ telegramId, address }) {
  if (!BEP20_ADDRESS_REGEX.test(address || '')) {
    const err = new Error('Invalid BEP-20 address format');
    err.statusCode = 400;
    throw err;
  }

  const currentRes = await client.execute({
    sql: 'SELECT wallet_address FROM users WHERE telegram_id = ?',
    args: [telegramId],
  });
  const current = currentRes.rows[0];
  if (!current) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const normalizedAddress = address.toLowerCase();

  // Reconnecting the same wallet they already own — fine, no-op.
  if (current.wallet_address && current.wallet_address.toLowerCase() === normalizedAddress) {
    return { wallet_address: current.wallet_address, already_connected: true };
  }

  // Already have a DIFFERENT wallet connected — require an explicit
  // disconnect first rather than silently swapping (a silent swap would
  // let someone re-point an old, farmed account at a new wallet, which
  // isn't the exploit this protects against, but is still worth being
  // deliberate about).
  if (current.wallet_address) {
    const err = new Error(
      `This account already has a wallet connected (${current.wallet_address}). Disconnect it first.`
    );
    err.statusCode = 409;
    throw err;
  }

  try {
    await client.execute({
      sql: 'UPDATE users SET wallet_address = ? WHERE telegram_id = ?',
      args: [normalizedAddress, telegramId],
    });
  } catch (err) {
    // The unique index violation is what actually catches a race or a
    // deliberate attempt to claim an address another account already owns.
    if (String(err.message || '').toLowerCase().includes('unique')) {
      const conflictErr = new Error('This wallet is already connected to a different account');
      conflictErr.statusCode = 409;
      throw conflictErr;
    }
    throw err;
  }

  return { wallet_address: normalizedAddress, already_connected: false };
}

async function disconnectWallet({ telegramId }) {
  await client.execute({
    sql: 'UPDATE users SET wallet_address = NULL WHERE telegram_id = ?',
    args: [telegramId],
  });
}

module.exports = { connectWallet, disconnectWallet, BEP20_ADDRESS_REGEX };
