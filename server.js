'use strict';

/* BOLTIX main — server.js
   Pairing architecture is a 1:1 port of the Madara bot, with hardened
   reconnect flow:
   - task.session always references the CURRENT socket (survives reconnects)
   - old/replaced sockets cannot mutate newer pairing state
   - credentials are flushed to disk before promoting the linked account
   - pairing-start lock prevents concurrent overlapping requests
   Message layer swaps Madara's commandHandler for the BOLTIX
   anti-ban queue + commands/ loader. No crash vocabulary in this file. */

const fs       = require('fs');
const path     = require('path');
const pkg      = require('./package.json');
const express  = require('express');
const QRCode   = require('qrcode');
const pino     = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const { pairRouter, setPairingController, updatePairingStatus } = require('./pair');
const antiban   = require('./antiban');
const messaging = require('./messaging');
const { jidToNumber, toJid } = require('./utils');
const { handleCommand } = require('./commands');

/* ============================================================
   CONFIG
============================================================ */
const logger       = pino({ level: 'silent' });
const SESSION_DIR  = path.join(__dirname, 'sessions');       // primary bot session
const PAIRING_DIR  = path.join(__dirname, 'pairing-auth');  // like Madara's auth/linked
const PREFIX       = '.';
const PORT         = process.env.PORT || 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeOwnerNumber(input) {
  let num = String(input || '').replace(/[^0-9]/g, '');
  if (!num) return null;
  if (num.startsWith('0') && num.length === 11) num = '234' + num.slice(1);
  if (!/^\d{8,15}$/.test(num)) return null;
  return num;
}
const OWNER_NUMBER = normalizeOwnerNumber(process.env.OWNER_NUMBER) || '2348163201351';

for (const dir of [SESSION_DIR, PAIRING_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ============================================================
   MAIN BOT STATE (dashboard reporting only; source of truth is
   the socketSessions registry, same as Madara)
============================================================ */
let qrText     = null;
let connected  = false;
let userJid    = null;
let connState  = 'boot';
let pendingFreshPairing = false;
let primaryLaunching    = false;

function isOwner(m) {
  const sender = m.key.participant || m.key.remoteJid;
  return jidToNumber(sender) === OWNER_NUMBER;
}
function primarySock() {
  return socketSessions.get('primary')?.socket || null;
}
function buildCtx() {
  const msg = messaging.makeMessaging(primarySock, antiban);
  return {
    prefix: PREFIX,
    ownerNumber: OWNER_NUMBER,
    version: pkg.version,
    isOwner,
    toJid: (arg) => toJid(arg, primarySock, OWNER_NUMBER),
    reply: msg.reply,
    sendTo: msg.sendTo,
    sendStatus: msg.sendStatus,
    getStats: antiban.getStats,
    caps: {
      dailyReached:      antiban.dailyCapReached,
      proactiveReached:  antiban.proactiveCapReached,
      warmupRemainingMs: () => Date.now() < antiban.warmupUntilAt() ? antiban.warmupUntilAt() - Date.now() : 0,
    },
  };
}

/* ============================================================
   SHARED SESSION REGISTRY (Madara)
============================================================ */
const socketSessions = new Map();
const pairingTasks   = new Map();
const messages      = new Map();
let waVersionPromise = null;

/* FIX 1: pairing-start lock — prevents two overlapping pairing requests
   from racing each other through openPairingSocket(). */
let pairingStartInProgress = false;

function normalizeJid(jid = '') {
  return String(jid || '').replace(/:\d+(?=@)/, '');
}
function normalNumber(jid = '') {
  return normalizeJid(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}
function storeKey(sessionId, jid, id) {
  return `${sessionId}|${normalizeJid(jid)}|${id}`;
}
function storeMessage(msg, sessionId) {
  if (!msg?.key?.id || !msg?.key?.remoteJid) return;
  for (const alias of new Set([normalizeJid(msg.key.remoteJid), normalizeJid(msg.key.remoteJidAlt || '')])) {
    if (alias) messages.set(storeKey(sessionId, alias, msg.key.id), msg);
  }
  while (messages.size > 4000) messages.delete(messages.keys().next().value);
}
function getStoredMessageForRetry(sessionId, key = {}) {
  if (!key?.id) return undefined;
  return messages.get(storeKey(sessionId, key.remoteJid || '', key.id))?.message;
}

async function getCurrentVersion() {
  const pinned = String(process.env.WA_VERSION || '').split(/[.,]/).map(Number);
  if (pinned.length === 3 && pinned.every(Number.isInteger)) return pinned;
  try {
    const found = await fetchLatestBaileysVersion();
    if (Array.isArray(found?.version) && found.version.length === 3) return found.version;
  } catch (error) { console.warn('Could not discover latest supported WhatsApp version:', error?.message || error); }
  return null;
}

/* ============================================================
   PAIRING TASK LIFECYCLE (Madara, with reconnect-flow hardening)
============================================================ */
function waitForReady(session, timeoutMs = 15000) {
  if (session.pairingReady) return Promise.resolve(true);
  let timer;
  return Promise.race([
    session.readyPromise,
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

/* FIX 2: markLinked reads the CURRENT session from the registry inside the
   link-timer callback, and falls back to task.session only if that's
   also what the task still points at. */
function markLinked(task) {
  if (!task || task.linked || task.cancelled || task.finished) return;

  task.linked = true;
  updatePairingStatus('linking', {}, task.id);
  clearTimeout(task.linkTimer);

  task.linkTimer = setTimeout(() => {
    const current = socketSessions.get(task.sessionId);

    if (task.finished || current?.connection === 'open') return;

    failPairing(
      task,
      'WhatsApp accepted the code but the connection did not finish. Generate a new code.'
    );

    disposeSession(task.session || current, true).catch(() => {});
  }, 3 * 60 * 1000);

  task.linkTimer.unref?.();
}

function finishTask(task) {
  clearTimeout(task.linkTimer);
  pairingTasks.delete(task.id);
}

function failPairing(task, reason) {
  if (!task || task.finished) return;
  task.finished = true;
  task.cancelled = true;
  updatePairingStatus('failed', { error: reason }, task.id);
  finishTask(task);
}

/* FIX 2: disposeSession also nulls the task's back-reference so a disposed
   session can never be mistaken for the live one. */
async function disposeSession(session, wipe = false) {
  if (!session) return;

  session.disposed = true;
  clearTimeout(session.reconnectTimer);

  session.resolveReady?.(false);
  session.resolveReady = null;

  const sock = session.socket;
  session.socket = null;
  session.connection = 'close';

  if (socketSessions.get(session.id) === session) {
    socketSessions.delete(session.id);
  }

  if (session.task?.session === session) {
    session.task.session = null;
  }

  try {
    sock?.end?.(new Error('Pairing socket disposed'));
  } catch {}

  if (wipe) {
    await fs.promises.rm(session.authDir, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

async function requestCodeForSession(session, task) {
  const ready = await waitForReady(session, 15000);
  if (!ready || session.disposed || !session.socket) throw new Error('WhatsApp pairing socket did not become ready. Retry the request.');
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (task.cancelled) throw new Error('Pairing cancelled.');
    if (session.disposed || task.session !== session) throw new Error('Pairing socket was replaced.');
    try {
      if (session.state.creds.registered) throw new Error('This number already has a registered WhatsApp session.');
      const code = String(await session.socket.requestPairingCode(task.number) || '').trim().toUpperCase();
      if (!code) throw new Error('WhatsApp returned an empty pairing code.');
      task.codeIssuedAt = Date.now();
      updatePairingStatus('code_ready', { code }, task.id);
      return code;
    } catch (error) {
      lastError = error;
      if (/already.*registered|cancelled|replaced/i.test(error?.message || '')) throw error;
      await sleep(1000 + attempt * 900);
    }
  }
  throw lastError || new Error('Failed to generate pairing code.');
}

async function openPairingSocket(task) {
  await disposeSession(task.session, false);
  task.session = null;
  await fs.promises.rm(task.authDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.mkdir(task.authDir, { recursive: true });
  const session = await launchSocketSession({ sessionId: task.sessionId, authDir: task.authDir, number: task.number, pairingId: task.id, task });
  task.session = session;
  return requestCodeForSession(session, task);
}

async function regeneratePairingCode(task, why = 'connection closed') {
  if (task.regenerating || task.cancelled || task.linked || task.finished) return;
  task.regenerating = true;
  try {
    for (let attempt = 0; attempt < 6 && !task.cancelled && !task.linked && !task.finished; attempt++) {
      updatePairingStatus('restarting', { message: 'Refreshing expired pairing code…' }, task.id);
      await sleep(Math.min(1000 + attempt * 1400, 8000));
      try { await openPairingSocket(task); return; }
      catch (error) { why = error?.message || String(error); console.warn('Pairing code refresh failed:', why); }
    }
    failPairing(task, `Could not refresh pairing code: ${why}`);
    await disposeSession(task.session, true);
  } finally { task.regenerating = false; }
}

async function cancelPairingSession(pairingId, reason = 'cancelled') {
  const task = pairingTasks.get(pairingId);
  if (!task) return;
  task.cancelled = true;
  task.finished = true;
  finishTask(task);
  const session = task.session;
  if (session && session.connection !== 'open' && !session.state.creds.registered) await disposeSession(session, true);
  console.log(`Pairing ${pairingId} ${reason}.`);
}

/* FIX 3: activeSessionCount excludes the primary bot socket so it is never
   counted as one of the linked-account slots. */
function activeSessionCount() {
  const activeNumbers = new Set();

  for (const session of socketSessions.values()) {
    if (session.isPrimary) continue;

    if (
      session.state?.creds?.registered ||
      session.connection === 'open' ||
      (session.task && !session.task.finished && !session.task.cancelled)
    ) {
      const number =
        session.number ||
        normalNumber(session.socket?.user?.id || '');

      activeNumbers.add(number || session.id);
    }
  }

  for (const task of pairingTasks.values()) {
    if (!task.finished && !task.cancelled) {
      activeNumbers.add(task.number);
    }
  }

  return activeNumbers.size;
}

/* FIX 4 helper: read creds.json on disk and check the registered flag. */
async function hasRegisteredCredentials(authDir) {
  try {
    const raw = await fs.promises.readFile(
      path.join(authDir, 'creds.json'),
      'utf8'
    );
    return Boolean(JSON.parse(raw)?.registered);
  } catch {
    return false;
  }
}

/* FIX 4: startPairingSession with the start lock, strict number
   normalization, primary-account guard, single-active-task guard and
   cancel-aware return. */
async function startPairingSession(number, pairingId) {
  if (pairingStartInProgress) {
    throw new Error('Another pairing request is already starting. Please retry shortly.');
  }

  pairingStartInProgress = true;

  try {
    number = String(number || '').replace(/\D/g, '');

    if (number.startsWith('0') && number.length === 11) {
      number = '234' + number.slice(1);
    }

    if (!/^\d{8,15}$/.test(number)) {
      throw new Error('Enter a valid phone number with country code.');
    }

    const primary = socketSessions.get('primary');

    if (
      connected ||
      primary?.state?.creds?.registered ||
      await hasRegisteredCredentials(SESSION_DIR)
    ) {
      throw new Error(
        'The bot already has a registered WhatsApp account. Log it out before pairing another number.'
      );
    }

    const activeTask = [...pairingTasks.values()].find(
      task => !task.finished && !task.cancelled
    );

    if (activeTask && activeTask.number !== number) {
      throw new Error('Another number is already being paired. Finish or cancel that request first.');
    }

    const sessionId = `linked:${number}`;
    const authDir = path.join(PAIRING_DIR, number);

    if (
      socketSessions.get(sessionId)?.state?.creds?.registered ||
      await hasRegisteredCredentials(authDir)
    ) {
      throw new Error('This number is already paired with the bot.');
    }

    const maxSessions = Math.max(
      1,
      Math.min(5, Number(process.env.MAX_LINKED_SESSIONS || 5))
    );

    const alreadyActive =
      socketSessions.has(sessionId) ||
      [...pairingTasks.values()].some(
        task => task.number === number && !task.finished && !task.cancelled
      );

    if (!alreadyActive && activeSessionCount() >= maxSessions) {
      throw new Error(`Session limit reached (${maxSessions}).`);
    }

    // Replace an older pending request for this same number.
    for (const old of [...pairingTasks.values()]) {
      if (old.number === number && !old.finished && !old.cancelled) {
        await cancelPairingSession(old.id, 'replaced');
      }
    }

    const task = {
      id: pairingId,
      number,
      sessionId,
      authDir,
      session: null,
      linked: false,
      cancelled: false,
      finished: false,
      firstCodeDelivered: false,
      regenerating: false,
      codeIssuedAt: 0,
      linkTimer: null
    };

    pairingTasks.set(pairingId, task);

    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const code = await openPairingSocket(task);

        if (task.cancelled || task.finished) {
          throw new Error('Pairing request was cancelled.');
        }

        task.firstCodeDelivered = true;
        return code;
      } catch (error) {
        lastError = error;

        if (
          task.cancelled ||
          /already.*registered|cancelled/i.test(error?.message || '')
        ) {
          break;
        }

        console.warn(
          `[pair] attempt ${attempt} failed:`,
          error?.message || error
        );

        await sleep(1000 + attempt * 700);
      }
    }

    task.cancelled = true;
    task.finished = true;
    finishTask(task);

    await disposeSession(task.session, true);

    throw lastError || new Error('Could not generate a pairing code.');
  } finally {
    pairingStartInProgress = false;
  }
}

/* Once a number links via the panel, promote its credentials into the
   primary bot session (BOLTIX is single-account). */
async function promoteLinkedAccount(authDir) {
  console.log('[link] device linked — activating bot session');

  const oldPrimary = socketSessions.get('primary');
  if (oldPrimary) await disposeSession(oldPrimary, false);

  await fs.promises.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  for (const f of fs.readdirSync(authDir)) {
    fs.copyFileSync(path.join(authDir, f), path.join(SESSION_DIR, f));
  }
  await fs.promises.rm(authDir, { recursive: true, force: true }).catch(() => {});

  pendingFreshPairing = true;
  connected = false;
  qrText = null;
  connState = 'connecting';
  const timer = setTimeout(() => {
    startPrimarySession().catch(err =>
      console.error('[pair] primary restart failed:', err?.message || err));
  }, 2000);
  timer.unref?.();
}

/* ============================================================
   SHARED SOCKET-SESSION MANAGER (Madara launchSocketSession
   with task/session reference hardening)
============================================================ */
async function launchSocketSession({ sessionId, authDir, number = '', pairingId = null, task = null, authBundle = null, isPrimary = false, fresh = false }) {
  const existing = socketSessions.get(sessionId);

  /* FIX 5: when reusing a live session, re-attach the task so it always
     points at the CURRENT socket. */
  if (existing?.socket && existing.connection !== 'close') {
    if (task && !task.finished && !task.cancelled) {
      task.session = existing;
    }

    return existing;
  }

  const { state, saveCreds } = authBundle || await useMultiFileAuthState(authDir);
  const version = await (waVersionPromise ||= getCurrentVersion());
  let resolveReady;

  const session = {
    id: sessionId, authDir, number, pairingId, task, state, saveCreds, socket: null,
    isPrimary, fresh, disposed: false, connection: 'connecting', pairingReady: false,
    reconnectTimer: null, openedAt: 0, handledIds: new Set(),
    readyPromise: new Promise(resolve => { resolveReady = resolve; }), resolveReady
  };

  const sock = makeWASocket({
    ...(version ? { version } : {}), logger, printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: isPrimary ? false : (!task || task.linked),
    syncFullHistory: false, browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: 60000, connectTimeoutMs: 60000, keepAliveIntervalMs: 15000,
    emitOwnEvents: true,
    getMessage: async key => getStoredMessageForRetry(sessionId, key)
  });
  session.socket = sock;
  socketSessions.set(sessionId, session);

  /* FIX 5: the task always references the newest session, including
     right after a reconnect created a replacement socket. */
  if (task && !task.finished && !task.cancelled) {
    task.session = session;
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    /* FIX 6: ignore events from replaced/closed sockets — only the session
       currently stored in the registry may mutate pairing state. */
    if (
      session.disposed ||
      socketSessions.get(sessionId) !== session
    ) {
      return;
    }
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr && !state.creds.registered) {
      session.pairingReady = true;
      session.resolveReady?.(true);
      session.resolveReady = null;
      if (session.isPrimary) {
        qrText = qr;
        connState = 'waiting_qr';
      }
    }
    if (isNewLogin && task) markLinked(task);

    if (connection === 'connecting') {
      session.connection = 'connecting';
      if (session.isPrimary) connState = 'connecting';
    }

    if (connection === 'open') {
      session.connection = 'open';
      session.openedAt = Date.now();
      console.log(`✅ BOLTIX session ${sessionId} connected.`);

      if (session.isPrimary) {
        connected = true;
        connState = 'connected';
        qrText = null;
        userJid = jidNormalizedUser(sock.user?.id);
        if (session.fresh || pendingFreshPairing) antiban.beginWarmup();
        pendingFreshPairing = false;
        return;
      }

      /* FIX 8: flush credentials to disk BEFORE promoting the linked
         account, so the primary session can always restore from disk. */
      if (task && !task.finished && !task.cancelled) {
        try {
          await session.saveCreds();
        } catch (error) {
          failPairing(
            task,
            'WhatsApp connected, but the login credentials could not be saved.'
          );

          await disposeSession(session, false);
          return;
        }

        task.finished = true;
        task.linked = true;

        clearTimeout(task.linkTimer);

        updatePairingStatus('open', {}, task.id);
        finishTask(task);

        const linkedAuthDir = session.authDir;

        task.session = null;
        session.task = null;

        await disposeSession(session, false).catch(() => {});

        promoteLinkedAccount(linkedAuthDir).catch(error => {
          console.error(
            '[pair] activation failed:',
            error?.stack || error
          );
        });
      }
      return;
    }

    if (connection === 'close') {
      session.connection = 'close';
      session.resolveReady?.(false);
      session.resolveReady = null;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const registered = Boolean(state.creds.registered);
      console.warn(`🔌 Session ${sessionId} closed (${statusCode ?? 'unknown'}): ${lastDisconnect?.error?.message || 'unknown reason'}`);

      if (session.isPrimary) {
        connected = false;
        userJid = null;
        qrText = null;
      }

      // Pre-link pairing socket: regenerate the expired code (Madara behavior).
      if (task && !task.linked && !registered) {
        if (task.firstCodeDelivered && !task.cancelled && !task.finished) {
          regeneratePairingCode(task, `${statusCode ?? 'closed'}`).catch(err =>
            console.error('Pairing refresh exception:', err?.message || err));
        }
        return;
      }

      if (loggedOut) {
        socketSessions.delete(sessionId);
        if (!session.isPrimary || sessionId === 'primary') await fs.promises.rm(authDir, { recursive: true, force: true }).catch(() => {});
        if (session.isPrimary) {
          console.log('[pair] logged out — wiping session for fresh start');
          connState = 'disconnected';
          antiban.resetWarmup();
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          const timer = setTimeout(() => {
            startPrimarySession().catch(err => console.error('[pair] restart after logout failed:', err?.message || err));
          }, 3000);
          timer.unref?.();
          return;
        }
        if (task && !task.finished) failPairing(task, 'WhatsApp logged out this linked device. Pair again.');
        return;
      }

      /* FIX 7: reconnect timer refuses to fire for replaced sockets and only
         carries live tasks forward on the retry. */
      if (session.isPrimary) {
        connState = 'reconnecting';
      }

      clearTimeout(session.reconnectTimer);

      session.reconnectTimer = setTimeout(async () => {
        if (
          session.disposed ||
          socketSessions.get(sessionId) !== session
        ) {
          return;
        }

        const currentTask =
          task && !task.finished && !task.cancelled
            ? task
            : null;

        try {
          await launchSocketSession({
            sessionId,
            authDir,
            number,
            pairingId,
            task: currentTask,
            authBundle: { state, saveCreds },
            isPrimary: session.isPrimary,
            fresh: session.fresh
          });
        } catch (error) {
          console.error(
            `[pair] reconnect failed for ${sessionId}:`,
            error?.stack || error
          );
        }
      }, statusCode === DisconnectReason.restartRequired ? 300 : 1800);
    }
  });

  sock.ev.on('messages.upsert', ({ messages: incoming = [], type }) => {
    if (type && type !== 'notify') return;
    for (const msg of incoming) {
      try {
        if (!msg?.key?.id || !msg?.key?.remoteJid || !msg.message) continue;
        storeMessage(msg, sessionId);
        const messageIdentity = storeKey(sessionId, msg.key.remoteJid, msg.key.id);
        if (msg.key.fromMe) continue;
        if (session.handledIds.has(messageIdentity)) continue;
        session.handledIds.add(messageIdentity);
        if (session.handledIds.size > 5000) session.handledIds.delete(session.handledIds.values().next().value);

        // Only the primary bot session dispatches commands.
        if (!session.isPrimary) continue;

        const ctx = buildCtx();
        antiban.recordInbound(msg);
        void (async () => {
          try { await handleCommand(msg, ctx); }
          catch (e) { console.error('[msg] error:', e?.message || e); }
        })();
      } catch (error) {
        console.error('Message dispatch error:', error?.stack || error);
      }
    }
  });

  return session;
}

/* ============================================================
   PRIMARY SESSION BOOT
============================================================ */
async function startPrimarySession() {
  if (primaryLaunching) return;
  primaryLaunching = true;
  try {
    await fs.promises.mkdir(SESSION_DIR, { recursive: true });
    let fresh = true;
    try {
      const creds = JSON.parse(await fs.promises.readFile(path.join(SESSION_DIR, 'creds.json'), 'utf8'));
      if (creds?.registered) fresh = false;
    } catch {}
    if (pendingFreshPairing) fresh = true;

    await launchSocketSession({ sessionId: 'primary', authDir: SESSION_DIR, isPrimary: true, fresh });
  } catch (error) {
    console.error('[start] initialization error:', error?.stack || error);
    const timer = setTimeout(() => startPrimarySession().catch(() => {}), 5000);
    timer.unref?.();
  } finally {
    primaryLaunching = false;
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
function maskJid(jid) {
  if (!jid) return null;
  const num = jidToNumber(jid);
  if (!num || num.length < 4) return '***';
  return num.slice(0, 2) + '***' + num.slice(-2);
}

const app = express();
app.use(express.json());
app.set('trust proxy', 1);

app.get('/', (_req, res) => {
  const html = path.join(__dirname, 'index.html');
  if (fs.existsSync(html)) return res.sendFile(html);
  return res.status(500).send('<h1>BOLTIX — dashboard missing</h1><p>Place index.html beside server.js.</p>');
});

/* Madara-style IP rate limits on the pairing endpoints */
const pairRateLimits = new Map();
const pairStatusRateLimits = new Map();
app.use('/api/pair', (req, res, next) => {
  if (req.method !== 'GET') return next();
  const now = Date.now();
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  if (req.path === '/' || req.path === '') {
    const recent = (pairRateLimits.get(ip) || []).filter(ts => now - ts < 15 * 60 * 1000);
    if (recent.length >= 8) return res.status(429).json({ ok: false, error: 'Too many pairing requests from this address. Wait 15 minutes and try again.' });
    recent.push(now); pairRateLimits.set(ip, recent);
    if (pairRateLimits.size > 1000) pairRateLimits.delete(pairRateLimits.keys().next().value);
  } else if (req.path === '/status' || req.path === '/cancel') {
    const recent = (pairStatusRateLimits.get(ip) || []).filter(ts => now - ts < 60 * 1000);
    if (recent.length >= 100) return res.status(429).json({ ok: false, error: 'Too many pairing-status requests. Slow down and retry.' });
    recent.push(now); pairStatusRateLimits.set(ip, recent);
    if (pairStatusRateLimits.size > 1000) pairStatusRateLimits.delete(pairStatusRateLimits.keys().next().value);
  }
  next();
});
app.use('/api/pair', pairRouter);

app.get('/health', (_req, res) => {
  const sessions = [...socketSessions.values()];
  res.json({
    ok: true, bot: 'BOLTIX', version: pkg.version,
    whatsapp: sessions.some(s => s.connection === 'open') ? 'open' : 'close',
    totalSessions: sessions.length,
    activePairingTasks: [...pairingTasks.values()].filter(t => !t.finished && !t.cancelled).length
  });
});

app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const active = [...pairingTasks.values()].some(t => !t.finished && !t.cancelled);
  res.json({
    connected,
    state: active && !connected ? 'pairing' : connState,
    user: connected ? maskJid(userJid) : null
  });
});

app.get('/api/qr', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!qrText) return res.json({ qr: null, state: connState, connected });
  try {
    res.json({ qr: await QRCode.toDataURL(qrText, { margin: 1, width: 360 }), state: connState, connected });
  } catch {
    res.json({ qr: null, state: connState, connected });
  }
});

/* Hand control of pairing to pair.js — identical to Madara's wiring. */
setPairingController({ startPairing: startPairingSession, cancelPairing: cancelPairingSession });

app.listen(PORT, () => {
  console.log('[web] BOLTIX bot listening on port', PORT);
  startPrimarySession().catch(err => console.error('[start] boot failed:', err?.message || err));
});

/* Clean shutdown like Madara */
function shutdown() {
  for (const session of socketSessions.values()) {
    try { session.disposed = true; clearTimeout(session.reconnectTimer); session.socket?.end?.(new Error('Server shutting down')); } catch {}
  }
  for (const task of pairingTasks.values()) {
    try { task.cancelled = true; task.finished = true; clearTimeout(task.linkTimer); } catch {}
  }
  pairingStartInProgress = false;
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
