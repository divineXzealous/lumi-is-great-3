// SOCIAL & PROFILE: marry, marryaccept, marrydecline, divorce, age/setage, bio/setbio, namechange/changename (+ profile).
// Fun in-bot stuff only: nothing here touches anyone's real WhatsApp profile. Marriage is 18+ and needs both people to have set their age.
const settings = require('./settings');
const config = require('./config');
const { numberOf } = require('./jid');
const { createStore } = require('./jsonStore');

const store = createStore('social', { users: {}, proposals: {} });
const PROPOSAL_MS = 5 * 60 * 1000;
const NAME_COOLDOWN_MS = 60 * 60 * 1000;
const jidOf = (n) => `${n}@s.whatsapp.net`;
const user = (n) => (store.data.users[n] ||= {});
const fmtAgo = (ms) => { const m = Math.floor(ms / 60000); if (m < 60) return `${Math.max(1, m)}m`; const h = Math.floor(m / 60); return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`; };

// The name Lumi uses for someone: their chosen name, else their WhatsApp name.
const displayName = (num, fallback = '') => (store.data.users[num] && store.data.users[num].name) || fallback;

// Who is being targeted: a real @tag or the person replied to.
function targetOf(ctx) {
  const tags = (ctx.taggedJids && ctx.taggedJids.length ? ctx.taggedJids : []).filter(Boolean);
  const j = tags[0] || ctx.ctxInfo?.participant;
  return j ? { jid: j, num: numberOf(j) } : null;
}
const isBot = (ctx, num) => [ctx.sock.user?.id, ctx.sock.user?.lid].filter(Boolean).map(numberOf).includes(num);
const isMarried = (n) => Boolean(store.data.users[n] && store.data.users[n].spouse);
const pending = (toNum) => {
  const p = store.data.proposals[toNum];
  if (p && Date.now() - p.at > PROPOSAL_MS) { delete store.data.proposals[toNum]; return null; }
  return p || null;
};
const tag = (num, jid) => ({ text: `@${num}`, jid: jid || jidOf(num) });
const adult = (n) => (store.data.users[n] && store.data.users[n].age) >= 18;
const need = (ctx) => `${settings.prefix()}setage 20`;

async function say(ctx, text, jids = []) {
  return ctx.sock.sendMessage(ctx.jid, { text, mentions: jids }, { quoted: ctx.msg });
}

module.exports = [
  {
    name: 'marry', aliases: ['propose'], category: 'SOCIAL & PROFILE', menu: ['marry @user'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Proposals go in a group, so everybody can witness it.');
      const t = targetOf(ctx);
      if (!t) return ctx.reply(`Tag who you're shooting your shot at, or reply to their message.\nExample: ${settings.prefix()}marry @crush`);
      const me = ctx.senderNum;
      if (t.num === me) return ctx.reply('Marry yourself? Self-love is lit, but nah. Tag someone else.');
      if (isBot(ctx, t.num)) return ctx.reply("Me? I'm flattered, but I'm married to the grind. Pick a human.");
      if (!adult(me)) return ctx.reply(`Marriage is 18+ only. Set your real age first: ${need(ctx)}`);
      if (!adult(t.num)) return ctx.reply("They haven't set an age (18+) yet. Tell them to run .setage first, then shoot again.");
      if (isMarried(me)) return ctx.reply(`You're already married to @${user(me).spouse}. Run ${settings.prefix()}divorce first. No double-dipping.`);
      if (isMarried(t.num)) return ctx.reply('Eyyy, they are already taken. Respect the ring.');
      if (pending(t.num)) return ctx.reply('Someone already shot their shot at them. Let that one finish first.');
      for (const [to, p] of Object.entries(store.data.proposals)) if (p.from === me && Date.now() - p.at <= PROPOSAL_MS) return ctx.reply(`You still have a proposal waiting on @${to}. Be patient, king/queen.`);
      store.data.proposals[t.num] = { from: me, fromJid: ctx.sender, toJid: t.jid, at: Date.now() };
      store.save();
      user(me).jid = ctx.sender; user(t.num).jid = t.jid; store.save();
      return say(ctx, `💍 *PROPOSAL ALERT* 💍\n\n@${me} just got on one knee for @${t.num}!\n\n@${t.num}, you've got 5 minutes:\n✅ ${settings.prefix()}marryaccept\n❌ ${settings.prefix()}marrydecline\n\nEverybody is watching. No pressure 👀`, [ctx.sender, t.jid]);
    },
  },
  {
    name: 'marryaccept', aliases: ['accept', 'iwill'], category: 'SOCIAL & PROFILE', menu: ['marryaccept'],
    run: async (ctx) => {
      const me = ctx.senderNum; const p = pending(me);
      if (!p) return ctx.reply("Nobody has proposed to you (or it expired). Relax, your time is coming.");
      if (isMarried(p.from) || isMarried(me)) { delete store.data.proposals[me]; store.save(); return ctx.reply('Too late: one of you is already taken now.'); }
      delete store.data.proposals[me];
      const at = Date.now();
      user(me).spouse = p.from; user(me).since = at; user(me).jid = ctx.sender;
      user(p.from).spouse = me; user(p.from).since = at; user(p.from).jid = p.fromJid;
      store.save();
      return say(ctx, `🎉💒 *THEY SAID YES!* 💒🎉\n\n@${p.from} and @${me} are now married!\nDrinks are on the group tonight 🥂🔥\n\nCongrats lovebirds. Don't make me come and settle quarrels.`, [p.fromJid, ctx.sender]);
    },
  },
  {
    name: 'marrydecline', aliases: ['decline', 'reject', 'idontwill'], category: 'SOCIAL & PROFILE', menu: ['marrydecline'],
    run: async (ctx) => {
      const me = ctx.senderNum; const p = pending(me);
      if (!p) return ctx.reply('Nobody is waiting on an answer from you.');
      delete store.data.proposals[me]; store.save();
      return say(ctx, `💀 *REJECTED* 💀\n\n@${me} looked at @${p.from} and said "nah, not today".\n@${p.from}, hold your head up. We move. 🫡`, [ctx.sender, p.fromJid]);
    },
  },
  {
    name: 'divorce', aliases: ['breakup'], category: 'SOCIAL & PROFILE', menu: ['divorce'],
    run: async (ctx) => {
      const me = ctx.senderNum; const u = user(me);
      if (!u.spouse) return ctx.reply("You're not even married. Who are you divorcing, your shadow?");
      const ex = u.spouse; const days = fmtAgo(Date.now() - (u.since || Date.now())); const exJid = (store.data.users[ex] && store.data.users[ex].jid) || jidOf(ex);
      delete u.spouse; delete u.since;
      if (store.data.users[ex]) { delete store.data.users[ex].spouse; delete store.data.users[ex].since; }
      store.save();
      return say(ctx, `💔 *IT'S OVER* 💔\n\n@${me} and @${ex} are done after ${days}.\nBoth of you are single again. Nobody go cry for me o. 😭`, [ctx.sender, exJid]);
    },
  },
  {
    name: 'age', category: 'SOCIAL & PROFILE', menu: ['age', 'setage <number>'],
    run: async (ctx) => {
      const t = targetOf(ctx); const num = t ? t.num : ctx.senderNum; const u = store.data.users[num];
      if (!u || !u.age) return ctx.reply(num === ctx.senderNum ? `You haven't set your age. ${settings.prefix()}setage 20` : "They haven't set an age yet.");
      return ctx.reply(num === ctx.senderNum ? `You are ${u.age}.` : `They are ${u.age}.`);
    },
  },
  {
    name: 'setage', category: 'SOCIAL & PROFILE', menu: [],
    run: async (ctx) => {
      const n = parseInt(ctx.args[0], 10);
      if (!Number.isInteger(n) || String(n) !== String(ctx.args[0]).trim()) return ctx.reply(`Give me a number. Example: ${settings.prefix()}setage 20`);
      if (n < 13) return ctx.reply('WhatsApp is 13+, so I need a real age of 13 or more.');
      if (n > 99) return ctx.reply("Come on. Put your real age.");
      const u = user(ctx.senderNum); u.age = n; u.jid = ctx.sender; store.save();
      return ctx.reply(`Age saved: ${n}. ${n >= 18 ? 'You can shoot your shot now 💍' : "Marriage opens at 18, but the rest of my commands are yours."}`);
    },
  },
  {
    name: 'bio', category: 'SOCIAL & PROFILE', menu: ['bio', 'setbio <text>'],
    run: async (ctx) => {
      const t = targetOf(ctx); const num = t ? t.num : ctx.senderNum; const u = store.data.users[num];
      if (!u || !u.bio) return ctx.reply(num === ctx.senderNum ? `You have no bio yet. ${settings.prefix()}setbio your words here` : 'They have no bio yet.');
      return ctx.reply(`📝 ${num === ctx.senderNum ? 'Your bio' : 'Their bio'}:\n${u.bio}`);
    },
  },
  {
    name: 'setbio', category: 'SOCIAL & PROFILE', menu: [],
    run: async (ctx) => {
      const text = ctx.argText.replace(/\s+/g, ' ').trim();
      if (!text) return ctx.reply(`Write your bio after the command.\nExample: ${settings.prefix()}setbio Chilling. Eating. Repeating.\nClear it with ${settings.prefix()}setbio clear`);
      const u = user(ctx.senderNum);
      if (/^(clear|remove|reset)$/i.test(text)) { delete u.bio; store.save(); return ctx.reply('Bio cleared. Clean slate.'); }
      if (text.length > 150) return ctx.reply('Keep it under 150 characters, we are not writing a novel.');
      if (/https?:\/\/|www\.|\b\S+\.(?:com|net|org|xyz|ng|io)\b/i.test(text)) return ctx.reply('No links in bios.');
      u.bio = text; u.jid = ctx.sender; store.save();
      return ctx.reply('Bio saved. Looking good. 😎');
    },
  },
  {
    name: 'namechange', aliases: ['changename', 'nick'], category: 'SOCIAL & PROFILE', menu: ['namechange <name>'],
    run: async (ctx) => {
      const name = ctx.argText.replace(/\s+/g, ' ').trim();
      const u = user(ctx.senderNum);
      if (!name) return ctx.reply(`What should I call you?\nExample: ${settings.prefix()}namechange Big Chris\n${u.name ? `Right now it's "${u.name}".` : ''}`.trim());
      if (/^(clear|reset|default)$/i.test(name)) { delete u.name; store.save(); return ctx.reply('Back to your WhatsApp name.'); }
      if (name.length < 2 || name.length > 20) return ctx.reply('Between 2 and 20 characters, please.');
      if (/[@<>]|https?:|www\.|\.\w{2,}\b/i.test(name)) return ctx.reply('No @, links or weird stuff in names.');
      const low = name.toLowerCase();
      if (low.includes('lumi') || low === String(config.owner.name || '').toLowerCase()) return ctx.reply("You can't be me or my owner. Pick your own name.");
      const left = (u.nameAt || 0) + NAME_COOLDOWN_MS - Date.now();
      if (!ctx.isOwner && left > 0) return ctx.reply(`Slow down, you changed it recently. Try again in ${Math.ceil(left / 60000)} min.`);
      u.name = name; u.nameAt = Date.now(); u.jid = ctx.sender; store.save();
      return ctx.reply(`Done. From now on I'll call you *${name}* 🔥`);
    },
  },
  {
    name: 'profile', aliases: ['me', 'whois'], category: 'SOCIAL & PROFILE', menu: ['profile'],
    run: async (ctx) => {
      const t = targetOf(ctx); const num = t ? t.num : ctx.senderNum; const u = store.data.users[num] || {};
      const name = u.name || (num === ctx.senderNum ? ctx.pushName : '') || `@${num}`;
      const lines = [`👤 *${name}*`, `🎂 Age: ${u.age || 'not set'}`, `📝 Bio: ${u.bio || 'not set'}`,
        `💞 Status: ${u.spouse ? `married to @${u.spouse} (${fmtAgo(Date.now() - (u.since || Date.now()))})` : 'single'}`];
      const mentions = [t ? t.jid : ctx.sender].concat(u.spouse ? [(store.data.users[u.spouse] || {}).jid || jidOf(u.spouse)] : []);
      return say(ctx, lines.join('\n').replace(`@${num}`, `@${num}`), mentions);
    },
  },
];
module.exports.displayName = displayName;
module.exports.init = () => store.load();
module.exports._store = store;
