// .block / .unblock / .blocklist (main owner): Lumi ignores blocked people everywhere, in private chats and in groups.
// She also tries to block them on WhatsApp itself (best effort). Owners, the protected person and Lumi herself cannot be blocked.
const settings = require('./settings');
const { numberOf } = require('./jid');
const { createStore } = require('./jsonStore');

const store = createStore('blocklist', { ids: {} });
const MAX = 500;
const list = () => store.data.ids || (store.data.ids = {});
const realNumber = (s) => String(s || '').replace(/\D/g, '');

// All the numbers/LIDs a message could come from.
const idsOfMsg = (msg) => [...new Set([msg.key.participant, msg.key.participantAlt, msg.key.participantPn,
  msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us') ? msg.key.remoteJid : null, msg.key.remoteJidAlt].filter(Boolean).map(numberOf))];
const isBlocked = (msg) => { if (msg.key.fromMe) return false; const l = list(); return idsOfMsg(msg).some((n) => l[n]); };

async function targets(ctx) {
  const raw = [];
  for (const t of (ctx.taggedJids && ctx.taggedJids.length ? ctx.taggedJids : ctx.mentioned || [])) raw.push(numberOf(t));
  if (!raw.length && ctx.ctxInfo && ctx.ctxInfo.participant) raw.push(numberOf(ctx.ctxInfo.participant));
  if (!raw.length) for (const a of ctx.args) { const d = realNumber(a); if (d.length >= 7 && d.length <= 16) raw.push(d); }
  if (!raw.length && !ctx.isGroup && !ctx.isOwner) return [];
  const out = [];
  let meta = null;
  if (ctx.isGroup && raw.length) { try { meta = await ctx.sock.groupMetadata(ctx.jid); } catch (_) { /* use what we have */ } }
  for (const n of [...new Set(raw)]) {
    const p = meta && meta.participants.find((x) => [x.id, x.lid, x.phoneNumber, x.jid].filter(Boolean).map(numberOf).includes(n));
    out.push([...new Set([n, ...(p ? [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf) : [])])]);
  }
  return out;
}
const guarded = (ctx, ids) => ids.some((x) => settings.isOwner(x) || settings.protectedIds().includes(x))
  || (ctx.botIds || []).some((b) => ids.includes(b));
const botIds = (sock) => [sock.user && sock.user.id, sock.user && sock.user.lid].filter(Boolean).map(numberOf);

module.exports = [
  {
    name: 'block', aliases: ['ban'], category: 'OWNER', menu: ['block'], mainOwnerOnly: true, mainOnly: true,
    run: async (ctx) => {
      const groups = await targets(ctx);
      if (!groups.length) return ctx.reply(`Tag them, reply to their message, or give a number.\nExample: ${settings.prefix()}block 2348012345678`);
      const l = list(); const done = []; const skipped = [];
      for (const ids of groups) {
        if (guarded({ botIds: botIds(ctx.sock) }, ids)) { skipped.push('an owner/me'); continue; }
        if (ids.some((x) => l[x])) { skipped.push('already blocked'); continue; }
        if (Object.keys(l).length >= MAX) { skipped.push('(list is full)'); continue; }
        for (const x of ids) l[x] = { at: Date.now(), by: ctx.senderNum };
        done.push(ids[0]);
        const phone = ids.find((x) => /^\d{7,15}$/.test(x));
        if (phone) ctx.sock.updateBlockStatus && ctx.sock.updateBlockStatus(`${phone}@s.whatsapp.net`, 'block').catch(() => {});
      }
      store.save();
      const parts = [];
      if (done.length) parts.push(`Blocked ${done.length}. I'll ignore ${done.length === 1 ? 'them' : 'them all'} everywhere.`);
      if (skipped.length) parts.push(`Skipped: ${skipped.join(', ')}.`);
      return ctx.reply(parts.join(' '));
    },
  },
  {
    name: 'unblock', aliases: ['unban'], category: 'OWNER', menu: ['unblock'], mainOwnerOnly: true, mainOnly: true,
    run: async (ctx) => {
      if ((ctx.args[0] || '').toLowerCase() === 'all') { const c = Object.keys(list()).length; store.data.ids = {}; store.save(); return ctx.reply(c ? 'Unblocked everyone.' : 'Nobody is blocked.'); }
      const groups = await targets(ctx);
      if (!groups.length) return ctx.reply(`Tag them, reply to their message, give a number, or use ${settings.prefix()}unblock all.`);
      const l = list(); let c = 0;
      for (const ids of groups) {
        if (!ids.some((x) => l[x])) continue;
        for (const x of ids) delete l[x];
        c++;
        const phone = ids.find((x) => /^\d{7,15}$/.test(x));
        if (phone) ctx.sock.updateBlockStatus && ctx.sock.updateBlockStatus(`${phone}@s.whatsapp.net`, 'unblock').catch(() => {});
      }
      store.save();
      return ctx.reply(c ? `Unblocked ${c}.` : "They weren't blocked.");
    },
  },
  {
    name: 'blocklist', aliases: ['blocked', 'banlist'], category: 'OWNER', menu: ['blocklist'], mainOwnerOnly: true, mainOnly: true,
    run: async (ctx) => {
      const nums = Object.keys(list()).filter((n) => /^\d{7,15}$/.test(n));
      const total = Object.keys(list()).length;
      if (!total) return ctx.reply('Nobody is blocked.');
      return ctx.reply(`Blocked (${nums.length}${total > nums.length ? ' + some hidden IDs' : ''}):\n${nums.map((n) => `• +${n}`).join('\n') || '(only hidden IDs)'}`);
    },
  },
];
module.exports.init = () => store.load();
module.exports.isBlocked = isBlocked;
module.exports._store = store;
