'use strict';

const { sleep, rand, jidToNumber } = require('./utils');

/* ============================================================
   RATE / BEHAVIOUR LIMITS — keeps the account looking human
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

let sendChain      = Promise.resolve();
let lastSentAt     = 0;
let sentToday      = 0;
let proactiveToday = 0;
let batchCount     = 0;
let dayStamp       = new Date().toDateString();
let sendReadyAt    = 0;

const inboundLedger = new Map();

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

/* ---------------- info for commands ---------------- */

function dailyCapReached()      { rollDay(); return sentToday >= ANTIBAN.DAILY_MAX; }
function proactiveCapReached()  { rollDay(); return proactiveToday >= ANTIBAN.PROACTIVE_DAILY_MAX; }
function warmupUntilAt()        { return sendReadyAt; }

function beginWarmup() {
  if (sendReadyAt === 0) {
    sendReadyAt = Date.now() + ANTIBAN.WARMUP_AFTER_PAIRING;
    console.log(`[antiban] fresh pairing — proactive sends paused for ${ANTIBAN.WARMUP_AFTER_PAIRING / 60000} min warm-up`);
  }
}

function resetWarmup() { sendReadyAt = 0; }

function getStats() {
  rollDay();
  return {
    sentToday,
    dailyMax: ANTIBAN.DAILY_MAX,
    proactiveToday,
    proactiveMax: ANTIBAN.PROACTIVE_DAILY_MAX,
    threads: inboundLedger.size,
    warmupRemainingMs: Date.now() < sendReadyAt ? sendReadyAt - Date.now() : 0,
  };
}

module.exports = {
  enqueueSend,
  recordInbound,
  isRecentThread,
  dailyCapReached,
  proactiveCapReached,
  warmupUntilAt,
  beginWarmup,
  resetWarmup,
  getStats,
  ANTIBAN,
};
