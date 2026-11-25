'use strict';

module.exports = {
  cmds: ['ping'],

  async handler(m, ctx) {
    await ctx.reply(m, `⚡ BOLTIX alive | v${ctx.version}`);
  }
};
