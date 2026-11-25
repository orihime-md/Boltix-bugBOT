'use strict';

/* BOLTIX pairing panel — Madara method, CommonJS, with code-expiry tracking.
   Exposes: pairRouter, setPairingController, updatePairingStatus
   Mounted at /api/pair by server.js.
   States: starting → code_ready → linking → open | restarting | failed | cancelled */

const express = require('express');
const crypto  = require('crypto');

/* WhatsApp pairing codes are valid roughly 5 minutes; the server-side link
   timer runs 3 minutes. Treat the code as expiring after 5 minutes so the
   dashboard countdown matches user expectations, and let the server's
   regenerate flow issue a fresh one. */
const CODE_TTL_MS = 5 * 60 * 1000;
const STATE_TTL_MS = 30 * 60 * 1000;

let controller = null;
const pairingStates = new Map();

function setPairingController(value) { controller = value; }

function sweepStaleStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [id, entry] of pairingStates) {
    if (entry.at < cutoff) pairingStates.delete(id);
  }
  if (pairingStates.size > 300) {
    // Hard cap: drop oldest entries until we are under budget.
    const ordered = [...pairingStates.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of ordered.slice(0, pairingStates.size - 300)) pairingStates.delete(id);
  }
}

function publishStatus(pairingId, state, data = {}) {
  if (!pairingId) return;
  const entry = { state, data, at: Date.now() };

  // Stamp expiry so the dashboard can show a live countdown on the code.
  if (state === 'code_ready') {
    entry.data.expiresAt = entry.data.expiresAt || (entry.at + CODE_TTL_MS);
  } else if (state === 'restarting') {
    // Old code is dead while a new one is generated.
    delete entry.data.expiresAt;
  } else if (state === 'open' || state === 'failed' || state === 'cancelled') {
    delete entry.data.expiresAt;
  }

  pairingStates.set(pairingId, entry);
  sweepStaleStates();
}

/* Called by the pairing internals in server.js. */
function updatePairingStatus(state, data = {}, pairingId) {
  publishStatus(pairingId, state, data);
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const number = String(req.query.number || '').replace(/\D/g, '');
    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({ ok: false, error: 'Provide a valid phone number with country code (10-15 digits).' });
    }
    if (!controller || typeof controller.startPairing !== 'function') {
      return res.status(500).json({ ok: false, error: 'Pairing service unavailable.' });
    }
    const pairingId = crypto.randomUUID();
    const code = await controller.startPairing(number, pairingId);
    return res.json({ ok: true, code, pairingId, number });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || 'Could not start pairing.' });
  }
});

router.get('/status', (req, res) => {
  const id = String(req.query.id || '');
  const entry = pairingStates.get(id);
  if (!entry) return res.status(404).json({ ok: false, error: 'Pairing session not found or expired.' });

  res.set('Cache-Control', 'no-store');

  const payload = { ok: true, state: entry.state, ...entry.data };

  // Live countdown in seconds, so the page never needs its own clock math.
  if (payload.expiresAt) {
    payload.expiresIn = Math.max(0, Math.floor((payload.expiresAt - Date.now()) / 1000));
  }
  return res.json(payload);
});

router.get('/cancel', async (req, res) => {
  const id = String(req.query.id || '');
  try { await controller?.cancelPairing?.(id, 'cancelled by user'); } catch {}
  publishStatus(id, 'cancelled', {});
  return res.json({ ok: true });
});

const pairRouter = router;
module.exports = { pairRouter, setPairingController, updatePairingStatus };
