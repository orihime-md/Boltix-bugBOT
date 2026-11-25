'use strict';

const { sleep, rand } = require('./utils');
const { ANTIBAN } = require('./antiban');

/* ============================================================
   Human-like sending pipelines. All outbound traffic goes through
   the anti-ban queue so replies and payloads behave like a person.
============================================================ */

function makeMessaging(getSock, antiban) {
  const { enqueueSend, isRecentThread } = antiban;

  /* Reply to a received message: mark read, subscribe presence,
     "type" for a plausible duration, then send. */
  function reply(m, text) {
    return enqueueSend(async () => {
      const sock = getSock();
      if (!sock) return;
      const from = m.key.remoteJid;
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

  /* Send an arbitrary payload to a JID. Resolves { ok }. */
  function sendTo(jid, payload, opts = {}) {
    return enqueueSend(async () => {
      const sock = getSock();
      if (!sock) return { ok: false };
      try {
        await sock.sendMessage(jid, payload, opts);
        return { ok: true };
      } catch (e) {
        console.error('[send] error:', e?.message);
        return { ok: false };
      }
    }, { proactive: !isRecentThread(jid) });
  }

  /* Publish a status visible to a specific JID. Resolves { ok }. */
  function sendStatus(jid, payload, opts = {}) {
    return enqueueSend(async () => {
      const sock = getSock();
      if (!sock) return { ok: false };
      try {
        await sock.sendMessage('status@broadcast', payload, {
          ...opts,
          statusJidList: [jid],
        });
        return { ok: true };
      } catch (e) {
        console.error('[status] error:', e?.message);
        return { ok: false };
      }
    }, { proactive: !isRecentThread(jid) });
  }

  return { reply, sendTo, sendStatus };
}

module.exports = { makeMessaging };
