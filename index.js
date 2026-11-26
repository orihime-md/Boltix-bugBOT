
'use strict';

/* BOLTIX command dispatcher
   Auto-loads command files from this folder.
   A command file must export:
     cmds:    [ 'name', ...aliases ]
     handler: async (m, ctx, arg) => {}

   ctx is built in server.js.
*/

const fs = require('fs');
const path = require('path');
const { getText } = require('./utils');

const registry = [];

const SKIP_FILES = new Set([
  'server.js',
  'index.js',
  'commands.js'
]);

// Load command modules safely.
for (const file of fs.readdirSync(__dirname)) {
  if (!file.endsWith('.js')) continue;
  if (SKIP_FILES.has(file)) continue;

  let mod;

  try {
    mod = require(path.join(__dirname, file));
  } catch (error) {
    console.error(
      `[cmds] failed to load ${file}:`,
      error?.message || error
    );
    continue;
  }

  if (
    mod &&
    Array.isArray(mod.cmds) &&
    typeof mod.handler === 'function'
  ) {
    registry.push(mod);
  }
}

console.log(
  `[cmds] loaded ${registry.length} command module(s):`,
  registry.map(mod => mod.cmds.join('/')).join(', ') || 'none'
);

async function handleCommand(m, ctx) {
  if (!m?.message || m.key?.fromMe) return;

  let text = '';

  try {
    text = getText(m.message);
  } catch (error) {
    console.error('[cmds] failed to read message:', error?.message);
    return;
  }

  if (!text || text.length > 4000) return;

  const prefix = ctx.prefix;

  if (!prefix || !text.startsWith(prefix)) return;

  const parts = text
    .slice(prefix.length)
    .trim()
    .split(/\s+/);

  const cmd = (parts[0] || '').toLowerCase();
  const arg = parts[1];

  if (!cmd) return;

  for (const entry of registry) {
    if (entry.cmds.includes(cmd)) {
      try {
        await entry.handler(m, ctx, arg);
      } catch (error) {
        console.error(
          `[cmd] ${cmd} error:`,
          error?.stack || error
        );
      }

      return;
    }
  }
}

module.exports = {
  handleCommand
};
