'use strict';

const { jidNormalizedUser, getContentType } = require('@whiskeysockets/baileys');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function jidToNumber(jid) {
  if (!jid) return null;
  const raw = String(jid).split('@')[0].split(':')[0];
  const digits = raw.replace(/[^0-9]/g, '');
  return digits || null;
}

function normalizeNumber(arg) {
  let num = String(arg || '').replace(/[^0-9]/g, '');
  if (!num) return null;
  if (num.startsWith('0') && num.length === 11) num = '234' + num.slice(1);
  if (!/^\d{8,15}$/.test(num)) return null;
  return num;
}

/* Resolve a phone number to a WhatsApp JID (owner is protected). */
async function toJid(arg, getSock, ownerNumber) {
  const num = normalizeNumber(arg);
  if (!num) return null;
  if (String(num) === String(ownerNumber)) return 'OWNER_PROTECTED';

  const sock = getSock();
  if (!sock) return null;

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

function getText(msg) {
  const t = getContentType(msg);
  if (!t) return '';
  switch (t) {
    case 'conversation':        return msg.conversation;
    case 'extendedTextMessage': return msg.extendedTextMessage?.text || '';
    default:                    return msg[t]?.caption || msg[t]?.text || '';
  }
}

module.exports = { sleep, rand, jidToNumber, normalizeNumber, toJid, getText };
