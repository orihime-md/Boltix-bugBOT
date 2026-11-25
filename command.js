'use strict';

/* BOLTIX command dispatcher — root-level auto-loader.
   Scans every .js file in the repo root and registers any module that
   exports:
     cmds:    [ 'name', ...aliases ]
     handler: async (m, ctx, arg) => {}
   To add a command, drop a file in the repo root and restart.
   No command vocabulary lives in this file. */

const fs   = require('fs');
const path = require('path');
const { getText } = require('./utils');

/* Never (re)require these from the loader — server.js would recurse,
   commands.js is this file. Everything else without cmds+handler
   (utils.js, antiban.js, messaging.js, pair.js…) is safely skipped
   by the export check below, and Node's module cache means a double
   require of those files shares the same instance as server.js. */
const SKIP_FILES = new Set(['server.js', path.basename(__filename)]);

const registry = [];

for (const file of fs.readdirSync(__dirname)) {
  if (!file.endsWith('.js')) continue;
  if (SKIP_FILES.has(file)) continue;

  let mod;
  try {
    mod = require(path.join(__dirname, file));
  } catch (e) {
    console.error(`[cmds] failed to load ${file}:`, e?.message);
    continue;
  }

  if (mod && Array.isArray(mod.cmds) && typeof mod.handler === 'function') {
    registry.push(mod);
  }
}

console.log(`[cmds] loaded ${registry.length} command module(s):`,
  registry.map(r => r.cmds.join('/')).join(', ') || 'none');

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
