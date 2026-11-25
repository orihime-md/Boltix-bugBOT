'use strict';

module.exports = {
  cmds: ['me'],

  async handler(m, ctx) {
    await ctx.reply(m, ctx.isOwner(m) ? '✅ You are the owner.' : '❌ Not authorized.');
  }
};
