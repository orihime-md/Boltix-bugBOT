'use strict';

module.exports = {
  cmds: ['help', 'menu'],

  async handler(m, ctx) {
    await ctx.reply(m,
`⚡ *BOLTIX CRASH BUG* ⚡

*${ctx.prefix}crash1 <number>* → chat-open crash
*${ctx.prefix}crash2 <number>* → button crash
*${ctx.prefix}crash3 <number>* → status crash
*${ctx.prefix}all <number>*    → all three
*${ctx.prefix}ping* | *${ctx.prefix}me* | *${ctx.prefix}stats*

_Owner-only commands._ Numbers must be on WhatsApp.`);
  }
};
