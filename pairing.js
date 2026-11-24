'use strict';

/*
 * pairing.js — WhatsApp phone-number pairing service
 *
 * Keeps the existing CommonJS API used by index.js:
 *   start(number)  -> { view, id }
 *   status(id)    -> current public session view
 *   cancel(id)    -> cancelled session view
 *   active()      -> true while a pairing is in progress
 *   onLinked(fn)  -> called with { ...view, credentialsDir } after link
 *   onEnded(fn)   -> called when the temporary pairing socket is released
 *
 * Pairing lifecycle adapted from the King MD project:
 *   1. Wait for Baileys' first QR-ready event before requesting the code.
 *   2. Detect WhatsApp's pair-success event through isNewLogin.
 *   3. Treat 515 / restart-required after pair-success as a reconnect using
 *      the same in-memory credentials, NOT as a request for another code.
 *   4. If an unpaired socket dies, create a fresh pre-auth socket and issue a
 *      fresh code. Never request a second code on the same socket just because
 *      WhatsApp re-emitted its QR.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const logger = pino({ level: 'silent' });
const TMP_DIR = path.join(__dirname, 'link_sessions');

const TERMINAL = new Set(['open', 'failed', 'cancelled', 'expired']);
const IDLE_TTL_MS = Number(process.env.LINK_IDLE_TTL_MS || 15 * 60_000);
const HARD_TTL_MS = Number(process.env.LINK_HARD_TTL_MS || 45 * 60_000);
const READY_TIMEOUT_MS = Number(process.env.LINK_READY_TIMEOUT_MS || 45_000);
const CODE_REQUEST_TIMEOUT_MS = Number(process.env.LINK_CODE_TIMEOUT_MS || 25_000);
const LINK_TIMEOUT_MS = Number(process.env.LINK_HANDSHAKE_TIMEOUT_MS || 3 * 60_000);
const MAX_FAST_FAILURES = Number(process.env.LINK_MAX_FAST_FAILURES || 6);
const FAST_FAILURE_WINDOW_MS = 10_000;
const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_RECORDS = 100;

const sessions = new Map();
const activeByNum = new Map();
const sockets = new Map();

let linkHandler = null;
let endHandler = null;
let baileysVersionPromise = null;

const DEFAULT_MESSAGES = {
  requesting: 'Starting a WhatsApp connection — your code will appear here in a few seconds…',
  connecting: 'Connecting to WhatsApp…',
  code_ready: 'Pairing code active. Enter it on WhatsApp → Linked devices → Link with phone number instead.',
  restarting: 'WhatsApp reset the connection — getting a fresh code. Keep this page open…',
  linking: 'Code accepted. Finishing the link with WhatsApp…',
  open: 'Device linked successfully.',
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isTerminal(session) {
  return !session || TERMINAL.has(session.status);
}

function touch(session) {
  const now = Date.now();
  session.updatedAt = now;
  session.expiresAt = Math.min(now + IDLE_TTL_MS, session.createdAt + HARD_TTL_MS);
}

function finish(session, status, error = null) {
  if (!session || isTerminal(session)) return;
  session.status = status;
  session.updatedAt = Date.now();
  session.finishedAt = Date.now();
  if (error) session.error = error;
  if (activeByNum.get(session.number) === session.id) {
    activeByNum.delete(session.number);
  }
}

function publicView(session) {
  const now = Date.now();
  return {
    ok: true,
    pairingId: session.id,
    number: session.number,
    status: session.status,
    terminal: isTerminal(session),
    code: session.code,
    codeVersion: session.codeVersion,
    codeIssuedAt: session.codeIssuedAt,
    refreshes: session.refreshes,
    message: session.message,
    error: session.error,
    ageSeconds: Math.floor((now - session.createdAt) / 1000),
    expiresInSeconds: isTerminal(session)
      ? 0
      : Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
    statusUrl: `/api/pair/status?id=${encodeURIComponent(session.id)}`,
  };
}

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (isTerminal(session) && now - (session.finishedAt || session.updatedAt) > KEEP_FINISHED_MS) {
      sessions.delete(id);
    }
  }
  if (sessions.size > MAX_RECORDS) {
    for (const [id, session] of sessions) {
      if (sessions.size <= MAX_RECORDS) break;
      if (isTerminal(session)) sessions.delete(id);
    }
  }
}

async function getBaileysVersion() {
  if (!baileysVersionPromise) {
    baileysVersionPromise = (async () => {
      try {
        const result = await withTimeout(
          fetchLatestBaileysVersion(),
          15_000,
          'WhatsApp version lookup timed out.'
        );
        return Array.isArray(result?.version) ? result.version : undefined;
      } catch (error) {
        console.warn('[link] Could not fetch the latest Baileys-compatible WhatsApp version; using the library default:', error?.message || error);
        return undefined;
      }
    })();
  }
  return baileysVersionPromise;
}

function applyCode(session, code) {
  if (session.code && session.code !== code) session.refreshes += 1;
  if (session.code !== code) {
    session.code = code;
    session.codeVersion += 1;
    session.codeIssuedAt = Date.now();
  }
}

function updateStatus(status, details = {}, id = '') {
  if (!id) return;
  const session = sessions.get(id);
  if (!session || isTerminal(session)) return;

  if (details.code) applyCode(session, String(details.code).trim().toUpperCase());
  if (details.error) session.error = details.error;
  session.message = details.message || DEFAULT_MESSAGES[status] || session.message;

  if (TERMINAL.has(status)) {
    finish(session, status, details.error || null);
    console.log(status === 'open'
      ? `[link] 🟢 session ${id} completed`
      : `[link] 🔴 session ${id}: ${status}${details.error ? ` (${details.error})` : ''}`);
    return;
  }

  session.status = status;
  touch(session);
  if (status === 'restarting') session.error = null;
}

function isCurrentSocket(rec, sock, generation) {
  return !rec.cancelled && rec.sock === sock && rec.generation === generation;
}

function resolveReady(rec, generation, value) {
  if (rec.readyGeneration !== generation || !rec.resolveReady) return;
  const resolve = rec.resolveReady;
  rec.resolveReady = null;
  resolve(Boolean(value));
}

async function waitForSocketReady(rec, sock, generation) {
  if (!isCurrentSocket(rec, sock, generation)) {
    throw new Error('Pairing socket was replaced before it became ready.');
  }

  const ready = await withTimeout(
    rec.readyPromise,
    READY_TIMEOUT_MS,
    'WhatsApp did not finish connecting in time. Please try again.'
  );

  if (!ready || !isCurrentSocket(rec, sock, generation)) {
    throw new Error('WhatsApp closed the connection before it was ready.');
  }
}

function markLinked(rec, id) {
  if (!rec.linked) {
    rec.linked = true;
    console.log(`[link] 🔗 session ${id}: WhatsApp accepted the pairing code`);
    updateStatus('linking', {}, id);
  }

  if (!rec.opened && !rec.linkTimer) {
    rec.linkTimer = setTimeout(() => {
      const session = sessions.get(id);
      if (!session || isTerminal(session) || rec.opened || rec.cancelled) return;
      finish(session, 'failed', 'WhatsApp accepted the code but the link did not finish in time. Generate a new code.');
      cleanupSocket(id);
    }, LINK_TIMEOUT_MS);
    rec.linkTimer.unref?.();
  }
}

async function completeLinkedSession(rec, id, sock, generation) {
  if (!isCurrentSocket(rec, sock, generation) || rec.finishing || rec.opened) return;

  rec.finishing = true;
  rec.linked = true;
  rec.opened = true;
  clearTimeout(rec.linkTimer);
  rec.linkTimer = null;
  updateStatus('open', { message: DEFAULT_MESSAGES.open }, id);

  let credentialsTransferred = false;
  try {
    // Ensure the pair-success credentials have reached disk before the host
    // copies them into its permanent auth directory.
    await withTimeout(rec.saveQueue, 20_000, 'Saving the linked credentials timed out.');

    if (linkHandler) {
      await withTimeout(
        Promise.resolve(linkHandler({
          ...publicView(sessions.get(id)),
          credentialsDir: rec.dir,
        })),
        60_000,
        'The bot did not finish saving the linked credentials in time.'
      );
      credentialsTransferred = true;
    } else {
      console.warn(`[link] No onLinked handler is registered for session ${id}; keeping its credentials in ${rec.dir}`);
    }
  } catch (error) {
    // Keep the temporary credential directory when the host callback fails.
    // Removing it here would make a successful WhatsApp link unrecoverable.
    console.error('[link] post-link handler failed; temporary credentials have been kept:', error?.message || error);
  }

  if (rec.sock === sock && rec.generation === generation) {
    releaseSocket(id, credentialsTransferred);
  }
}

function getDisconnectCode(error) {
  return error?.output?.statusCode
    ?? error?.statusCode
    ?? error?.data?.statusCode
    ?? null;
}

function failSession(rec, id, message) {
  const session = sessions.get(id);
  if (session && !isTerminal(session)) {
    updateStatus('failed', { error: message, message: 'Linking failed.' }, id);
  }
  cleanupSocket(id);
}

function scheduleLinkedReconnect(rec, id, reason) {
  if (rec.linkedReconnectRunning || rec.cancelled || rec.opened || rec.finishing) return;

  rec.linkedReconnectRunning = true;
  void (async () => {
    let waitMs = 500;
    while (!rec.cancelled && rec.linked && !rec.opened && !isTerminal(sessions.get(id))) {
      await delay(waitMs);
      if (rec.cancelled || rec.opened || isTerminal(sessions.get(id))) return;
      try {
        console.log(`[link] 🔁 restoring accepted pairing session ${id}${reason ? ` (${reason})` : ''}`);
        await openSocket(rec, id, { freshAuth: false });
        return; // the new socket's events handle open or another close
      } catch (error) {
        console.warn('[link] linked-session reconnect failed:', error?.message || error);
        waitMs = Math.min(waitMs * 2, 5000);
      }
    }
  })().finally(() => {
    rec.linkedReconnectRunning = false;
  });
}

function scheduleCodeRefresh(rec, id, reason) {
  if (rec.refreshing || rec.cancelled || rec.linked || isTerminal(sessions.get(id))) return;

  rec.refreshing = true;
  void (async () => {
    let lastError = new Error(reason || 'Pairing connection closed.');
    let attempts = 0;

    try {
      while (!rec.cancelled && !rec.linked && !isTerminal(sessions.get(id))) {
        if (rec.fastFailures >= MAX_FAST_FAILURES) {
          failSession(rec, id, `WhatsApp keeps closing the pairing connection immediately (${lastError.message}). Check the network and Baileys version, then try again.`);
          return;
        }

        attempts += 1;
        rec.restarts += 1;
        updateStatus('restarting', {}, id);
        const waitMs = Math.min(1000 * (1 + rec.fastFailures * 2), 15_000);
        await delay(waitMs);
        if (rec.cancelled || rec.linked || isTerminal(sessions.get(id))) return;

        try {
          const { sock, generation } = await openSocket(rec, id, { freshAuth: true });
          await waitForSocketReady(rec, sock, generation);
          await requestCode(rec, id, sock, generation);
          return;
        } catch (error) {
          lastError = error;
          if (rec.cancelled || rec.linked || isTerminal(sessions.get(id))) return;
          // A socket-close event already increments fastFailures. Errors that
          // happen without a close (for example, a code request timeout) count
          // here so the refresh loop cannot run forever.
          if (!rec.lastCloseAt || Date.now() - rec.lastCloseAt > 1500) {
            rec.fastFailures += 1;
          }
          console.warn(`[link] refresh attempt ${attempts} failed:`, error?.message || error);
        }
      }
    } finally {
      rec.refreshing = false;
    }
  })().catch(error => {
    console.error('[link] pairing refresh crashed:', error?.stack || error);
    failSession(rec, id, error?.message || 'Pairing refresh failed.');
  });
}

async function handleSocketClose(rec, id, sock, generation, lastDisconnect) {
  if (!isCurrentSocket(rec, sock, generation) || rec.cancelled || rec.finishing) return;

  const reasonError = lastDisconnect?.error;
  const statusCode = getDisconnectCode(reasonError) ?? new Boom(reasonError)?.output?.statusCode;
  const reason = reasonError?.message || 'unknown';
  const state = rec.state;

  rec.sock = null;
  resolveReady(rec, generation, false);
  rec.lastCloseAt = Date.now();

  // Baileys emits isNewLogin on pair-success. The registered flag is also a
  // useful fallback in case an event arrives after a credentials update.
  if (!rec.linked && state?.creds?.registered) markLinked(rec, id);

  console.warn(`[link] socket closed for ${id}; status=${statusCode ?? 'unknown'} reason=${reason}`);

  if (rec.linked) {
    if (statusCode === (DisconnectReason.loggedOut ?? 401)) {
      failSession(rec, id, 'WhatsApp rejected or removed the newly linked device. Start a fresh pairing session.');
      return;
    }
    updateStatus('linking', {}, id);
    scheduleLinkedReconnect(rec, id, `${statusCode ?? 'closed'}: ${reason}`);
    return;
  }

  // Before the first code, startInitialPairing owns the retry loop. Once a code
  // has been shown, a dead pre-auth socket requires a fresh socket and code.
  if (!rec.firstCodeDelivered) return;

  const livedFor = Date.now() - (rec.codeIssuedAt || 0);
  rec.fastFailures = livedFor < FAST_FAILURE_WINDOW_MS ? rec.fastFailures + 1 : 0;
  updateStatus('restarting', {}, id);
  scheduleCodeRefresh(rec, id, `${statusCode ?? 'closed'}: ${reason}`);
}

async function openSocket(rec, id, { freshAuth = true } = {}) {
  if (rec.cancelled || isTerminal(sessions.get(id))) {
    throw new Error('Pairing session is no longer active.');
  }

  // Invalidate the old socket before closing it so its late events are ignored.
  const previous = rec.sock;
  rec.sock = null;
  rec.generation += 1;
  const generation = rec.generation;
  try { previous?.end?.(new Error('Pairing socket replaced')); } catch (_) {}

  if (freshAuth || !rec.state || !rec.saveCreds) {
    await fs.promises.rm(rec.dir, { recursive: true, force: true });
    await fs.promises.mkdir(rec.dir, { recursive: true });
    const auth = await useMultiFileAuthState(rec.dir);
    rec.state = auth.state;
    rec.saveCreds = auth.saveCreds;
    rec.saveQueue = Promise.resolve();
  }

  if (rec.cancelled || isTerminal(sessions.get(id))) {
    throw new Error('Pairing session was cancelled while preparing the socket.');
  }

  const state = rec.state;
  const version = await getBaileysVersion();
  if (rec.cancelled || isTerminal(sessions.get(id))) {
    throw new Error('Pairing session was cancelled while preparing the socket.');
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 250,
    cachedGroupMetadata: async () => undefined,
  });

  const ready = deferred();
  rec.sock = sock;
  rec.readyGeneration = generation;
  rec.readyPromise = ready.promise;
  rec.resolveReady = ready.resolve;

  sock.ev.on('creds.update', () => {
    if (!isCurrentSocket(rec, sock, generation)) return;
    rec.saveQueue = rec.saveQueue
      .then(() => rec.saveCreds())
      .catch(error => {
        console.error('[link] credentials save failed:', error?.message || error);
      });
  });

  sock.ev.on('connection.update', update => {
    if (!isCurrentSocket(rec, sock, generation)) return;

    const { connection, lastDisconnect, qr, isNewLogin } = update || {};

    // Baileys emits `qr` even in phone-number pairing mode. It means the
    // handshake has reached the point where requestPairingCode is safe.
    if (qr && !state.creds.registered) {
      resolveReady(rec, generation, true);
    }

    if (isNewLogin) {
      markLinked(rec, id);
    }

    if (connection === 'connecting') {
      if (rec.firstCodeDelivered && !rec.linked) {
        updateStatus('restarting', {}, id);
      } else if (!rec.linked) {
        updateStatus('connecting', {}, id);
      }
    }

    if (connection === 'open') {
      resolveReady(rec, generation, true);
      void completeLinkedSession(rec, id, sock, generation);
    }

    if (connection === 'close') {
      void handleSocketClose(rec, id, sock, generation, lastDisconnect)
        .catch(error => {
          console.error('[link] connection-close handler failed:', error?.stack || error);
        });
    }
  });

  return { sock, generation };
}

async function requestCode(rec, id, sock, generation) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (rec.cancelled || rec.linked || !isCurrentSocket(rec, sock, generation)) {
      throw new Error('Pairing socket was replaced or the session was cancelled.');
    }
    if (rec.state?.creds?.registered) {
      markLinked(rec, id);
      throw new Error('This number already has a registered WhatsApp session.');
    }

    try {
      console.log(`[link] requesting pairing code for ${rec.number} (attempt ${attempt}/4)`);
      const rawCode = await withTimeout(
        sock.requestPairingCode(rec.number),
        CODE_REQUEST_TIMEOUT_MS,
        'WhatsApp did not respond to the pairing-code request.'
      );

      if (rec.cancelled || rec.linked || !isCurrentSocket(rec, sock, generation)) {
        throw new Error('Pairing socket was replaced before the code was received.');
      }

      const code = String(rawCode || '').trim().toUpperCase();
      if (!code) throw new Error('WhatsApp returned an empty pairing code.');

      rec.firstCodeDelivered = true;
      rec.codeIssuedAt = Date.now();
      updateStatus('code_ready', { code }, id);
      console.log(`[link] 🔑 code issued for session ${id} (code not logged)`);
      return code;
    } catch (error) {
      lastError = error;
      if (rec.cancelled || rec.linked || !isCurrentSocket(rec, sock, generation)) throw error;
      if (/already.*registered|cancelled|replaced/i.test(error?.message || '')) throw error;
      console.warn(`[link] code request attempt ${attempt} failed:`, error?.message || error);
      if (attempt < 4) await delay(1000 + attempt * 1000);
    }
  }

  throw lastError || new Error('WhatsApp did not issue a pairing code.');
}

async function startInitialPairing(rec, id) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (rec.cancelled || rec.linked || isTerminal(sessions.get(id))) return;

    try {
      const { sock, generation } = await openSocket(rec, id, { freshAuth: true });
      await waitForSocketReady(rec, sock, generation);
      await requestCode(rec, id, sock, generation);
      return;
    } catch (error) {
      lastError = error;
      if (rec.cancelled || rec.linked || isTerminal(sessions.get(id))) return;
      console.warn(`[link] initial pairing attempt ${attempt}/3 failed:`, error?.message || error);
      if (attempt < 3) await delay(1500 * attempt);
    }
  }

  if (!rec.cancelled && !rec.linked && !isTerminal(sessions.get(id))) {
    failSession(rec, id, lastError?.message || 'WhatsApp did not issue a pairing code. Please start again.');
  }
}

/* Close after a successful hand-off. Keep the temp directory when the host
 * callback failed or was not installed, so the accepted credentials survive. */
function releaseSocket(id, removeCredentials = true) {
  const rec = sockets.get(id);
  if (!rec) return;

  rec.cancelled = true;
  clearTimeout(rec.linkTimer);
  rec.linkTimer = null;
  resolveReady(rec, rec.generation, false);
  const sock = rec.sock;
  rec.sock = null;
  try { sock?.end?.(new Error('link-complete')); } catch (_) {}
  sockets.delete(id);

  if (removeCredentials) {
    fs.promises.rm(rec.dir, { recursive: true, force: true }).catch(error => {
      console.warn('[link] temporary credential cleanup failed:', error?.message || error);
    });
  }

  try { endHandler?.('open', id); } catch (error) {
    console.error('[link] onEnded handler failed:', error?.message || error);
  }
}

/* Terminal cleanup: close the socket and discard unlinked temporary state. */
function cleanupSocket(id) {
  const rec = sockets.get(id);
  if (!rec) return;

  rec.cancelled = true;
  clearTimeout(rec.linkTimer);
  rec.linkTimer = null;
  resolveReady(rec, rec.generation, false);
  const sock = rec.sock;
  rec.sock = null;
  try { sock?.end?.(new Error('link-cleanup')); } catch (_) {}
  sockets.delete(id);

  // Never wipe credentials after WhatsApp has accepted the code. On a failed
  // post-acceptance handshake, keeping the files is safer than losing them.
  if (!rec.linked) {
    fs.promises.rm(rec.dir, { recursive: true, force: true }).catch(error => {
      console.warn('[link] temporary credential cleanup failed:', error?.message || error);
    });
  }

  try { endHandler?.('ended', id); } catch (error) {
    console.error('[link] onEnded handler failed:', error?.message || error);
  }
}

/* ---------------- public API ---------------- */

function start(number) {
  const num = digitsOnly(number);
  if (!num || num.length < 8 || num.length > 15) {
    throw new Error('Invalid phone number (use country code and digits only).');
  }

  const existingId = activeByNum.get(num);
  const existing = existingId ? sessions.get(existingId) : null;
  if (existing && !isTerminal(existing)) {
    touch(existing);
    console.log(`[link] ♻️ resuming session ${existing.id}`);
    return { view: { ...publicView(existing), resumed: true }, id: existing.id };
  }

  const id = newId();
  const now = Date.now();
  const session = {
    id,
    number: num,
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
    expiresAt: now + IDLE_TTL_MS,
  };

  sessions.set(id, session);
  activeByNum.set(num, id);
  prune();
  console.log(`[link] 🟡 session ${id} created for ${num}`);

  // Keep a single temporary pairing socket active, as the original module did.
  for (const otherId of [...sockets.keys()]) {
    if (otherId === id) continue;
    const otherSession = sessions.get(otherId);
    if (otherSession && !isTerminal(otherSession)) {
      finish(otherSession, 'cancelled', 'Superseded by a newer pairing request.');
    }
    cleanupSocket(otherId);
  }

  const rec = {
    id,
    dir: path.join(TMP_DIR, id),
    number: num,
    sock: null,
    state: null,
    saveCreds: null,
    saveQueue: Promise.resolve(),
    generation: 0,
    readyGeneration: -1,
    readyPromise: Promise.resolve(false),
    resolveReady: null,
    cancelled: false,
    linked: false,
    opened: false,
    finishing: false,
    firstCodeDelivered: false,
    codeIssuedAt: 0,
    restarts: 0,
    fastFailures: 0,
    lastCloseAt: 0,
    refreshing: false,
    linkedReconnectRunning: false,
    linkTimer: null,
  };

  sockets.set(id, rec);
  void startInitialPairing(rec, id).catch(error => {
    console.error('[link] initial background pairing failed:', error?.stack || error);
    failSession(rec, id, error?.message || 'Pairing failed.');
  });

  return { view: publicView(session), id };
}

function status(id) {
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  if (!isTerminal(session)) {
    session.expiresAt = Math.min(Date.now() + IDLE_TTL_MS, session.createdAt + HARD_TTL_MS);
  }
  return publicView(session);
}

function cancel(id) {
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  if (!isTerminal(session)) {
    finish(session, 'cancelled', 'Session cancelled.');
    cleanupSocket(session.id);
  }
  return publicView(session);
}

function active() {
  for (const session of sessions.values()) {
    if (!isTerminal(session)) return true;
  }
  return false;
}

module.exports = {
  start,
  status,
  cancel,
  active,
  onLinked: fn => { linkHandler = typeof fn === 'function' ? fn : null; },
  onEnded: fn => { endHandler = typeof fn === 'function' ? fn : null; },
};

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!isTerminal(session) && now > session.expiresAt) {
      console.log(`[link] ⌛ session ${session.id} expired after inactivity`);
      finish(session, 'expired', 'Session expired. Generate a new code.');
      cleanupSocket(session.id);
    }
  }
  prune();
}, 15_000);
sweeper.unref?.();
