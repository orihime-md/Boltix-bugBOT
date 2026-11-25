'use strict';

/* Auto-loads every command file in this folder. A command file must
   export:
     cmds:    [ 'name', ...aliases ]
     handler: async (m, ctx, arg) => {}
   ctx is built in server.js (reply, sendTo, sendStatus, toJid,
   isOwner, getStats, caps, prefix, version...). */

const fs   = require('fs');
const path = require('path');
const { getText } = require('../utils');

const registry = [];

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const mod = require(path.join(__dirname, file));
  if (mod && Array.isArray(mod.cmds) && typeof mod.handler === 'function') {
    registry.push(mod);
  }
}

async function handleCommand(m, ctx) {
  if (!m.message || m.key.fromMe) return;

  let text = '';
  try { text = getText(m.message); } catch (_) { return; }
  if (!text || text.length > 4000) return;
  if (!text.startsWith(ctx.prefix)) return;

  const parts = text.slice(ctx.prefix.length).trim().split(/\s+/);
  const cmd   = (parts[0] || '').toLowerCase();
  const arg   = parts[1];

  for (const entry of registry) {
    if (entry.cmds.includes(cmd)) {
      try { await entry.handler(m, ctx, arg); }
      catch (e) { console.error('[cmd] error:', e?.message); }
      return;
    }
  }
}

module.exports = { handleCommand };
