'use strict';

module.exports = {
  cmds: ['stats'],

  async handler(m, ctx) {
    if (!ctx.isOwner(m)) { await ctx.reply(m, '❌ Not authorized.'); return; }

    const s = ctx.getStats();
    const warm = s.warmupRemainingMs > 0
      ? `⏳ warm-up: ${Math.ceil(s.warmupRemainingMs / 1000)}s left`
      : '✅ warm-up done';

    await ctx.reply(m,
`📊 *Anti-ban status*

📤 Sent today: ${s.sentToday}/${s.dailyMax}
🎯 Proactive today: ${s.proactiveToday}/${s.proactiveMax}
🧵 Active threads: ${s.threads}
${warm}`);
  }
};
