// Group fun/tools: .poll, .gcpp, and the "jail" (.jail / .unjail / .jailed).
// Jail: Lumi deletes every message a jailed person sends in that group. She must be a group admin
// (WhatsApp only lets admins delete other people's messages). Group admins and owners can't be jailed.
const settings = require('./settings');
const { numberOf } = require('./jid');
const { groupInfo } = require('./groupTools');
const { createStore } = require('./jsonStore');
const http = require('./http');
const log = require('./logger');

// ---------------------------------------------------------------- helpers
async function guard(ctx) {
  if (!ctx.isGroup) { await ctx.reply('Groups only.'); return null; }
  const info = await groupInfo(ctx.sock, ctx.jid);
  if (!ctx.isOwner && !info.admins.has(ctx.senderNum)) { await ctx.reply('Admins only.'); return null; }
  if (!info.botIsAdmin) { await ctx.reply("Make me an admin first. I can't delete messages otherwise."); return null; }
  return info;
}
const getTargets = (ctx) => [...new Set(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []))];
const idsOf = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf);

// ---------------------------------------------------------------- poll
const POLL_COOLDOWN_MS = 15000;
const pollAt = new Map();
// .poll Best food? | Rice | Beans | Yam      (2-12 options; add --multi to allow several answers)
function parsePoll(raw) {
  let text = String(raw || '');
  const multi = /(?:^|\s)--multi\b/i.test(text);
  text = text.replace(/(?:^|\s)--multi\b/ig, ' ').trim();
  const parts = text.split(/\s*[|\n]\s*/).map((s) => s.trim()).filter(Boolean);
  const [name, ...values] = parts;
  const uniq = [...new Set(values)];
  return { name, values: uniq, multi };
}

// ---------------------------------------------------------------- jail
const store = createStore('jail', { groups: {} });
const MAX_JAILED_PER_GROUP = 20;
const MAX_JAIL_MS = 7 * 24 * 3600 * 1000;
function parseJailTime(a) {
  const m = /^(\d+)\s*(m|min|h|hr|d|day|days)$/i.exec(String(a || '').trim());
  if (!m) return null;
  const u = m[2].toLowerCase();
  const ms = parseInt(m[1], 10) * (u.startsWith('d') ? 86400000 : u.startsWith('h') ? 3600000 : 60000);
  return ms >= 60000 && ms <= MAX_JAIL_MS ? ms : null;
}
const fmt = (ms) => { const m = Math.ceil(ms / 60000); return m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`; };
const groupJail = (jid) => store.data.groups[jid] || {};

// Is this sender jailed in this group? Returns the record or null. Expired entries are dropped.
function jailRecord(jid, ids) {
  const g = store.data.groups[jid];
  if (!g) return null;
  for (const [key, rec] of Object.entries(g)) {
    if (rec.until && rec.until <= Date.now()) { delete g[key]; store.save(); continue; }
    if (rec.ids.some((n) => ids.includes(n))) return rec;
  }
  return null;
}
const senderIds = (msg) => [...new Set([msg.key.participant, msg.key.participantAlt, msg.key.participantPn].filter(Boolean).map(numberOf))];

// Called by the message handler for every group message. true = it was a jailed person's message (handled).
async function check(ctx) {
  if (!ctx.isGroup || !store.data.groups[ctx.jid]) return false;
  if (settings.isOwner(ctx.senderNum)) return false;
  if (!jailRecord(ctx.jid, senderIds(ctx.msg))) return false;
  try { await ctx.sock.sendMessage(ctx.jid, { delete: ctx.msg.key }); }
  catch (e) { log.warn('Jail delete failed:', e.message); }
  return true;
}

module.exports = [
  {
    name: 'poll', aliases: ['createpoll'], category: 'GROUP TOOLS', menu: ['poll <question> | <option> | <option>'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Polls are for groups.');
      const p = settings.prefix();
      const { name, values, multi } = parsePoll(ctx.argText || (ctx.text.split(/\s+/).slice(1).join(' ')));
      if (!name || values.length < 2) return ctx.reply(`Give me a question and at least 2 options, split with |\nExample: ${p}poll Best food? | Rice | Beans | Yam\nAdd --multi to let people pick several.`);
      if (values.length > 12) return ctx.reply('12 options at most.');
      if (name.length > 200 || values.some((v) => v.length > 100)) return ctx.reply('Keep the question under 200 characters and each option under 100.');
      if (!ctx.isOwner && Date.now() - (pollAt.get(ctx.jid) || 0) < POLL_COOLDOWN_MS) return ctx.reply('One poll at a time. Give it a few seconds.');
      pollAt.set(ctx.jid, Date.now());
      await ctx.sock.sendMessage(ctx.jid, { poll: { name, values, selectableCount: multi ? 0 : 1 } });
    },
  },
  {
    // .gcpp  -> this group's picture. Owner can also DM: .gcpp <part of the group name>
    name: 'gcpp', aliases: ['gcpic', 'groupicon', 'gcicon', 'getgcpp'], category: 'GROUP TOOLS', menu: ['gcpp'],
    run: async (ctx) => {
      let target = ctx.isGroup ? ctx.jid : null;
      let title = '';
      if (!target) {
        if (!ctx.isOwner) return ctx.reply('Use this inside the group.');
        const q = ctx.argText.trim().toLowerCase();
        if (!q) return ctx.reply(`Use it in the group, or tell me which one: ${settings.prefix()}gcpp <group name>`);
        const all = Object.values(await ctx.sock.groupFetchAllParticipating());
        const hits = all.filter((g) => String(g.subject || '').toLowerCase().includes(q));
        if (!hits.length) return ctx.reply("I'm not in a group with that name.");
        if (hits.length > 1) return ctx.reply(`More than one match:\n${hits.slice(0, 8).map((g) => `• ${g.subject}`).join('\n')}\nBe more specific.`);
        target = hits[0].id; title = hits[0].subject;
      }
      let url;
      try { url = await ctx.sock.profilePictureUrl(target, 'image'); }
      catch (_) { return ctx.reply("This group has no picture, or I can't see it."); }
      if (!url) return ctx.reply('This group has no picture.');
      const img = await http.request(url, { as: 'buffer', timeoutMs: 15000 });
      return ctx.sock.sendMessage(ctx.jid, { image: img, caption: title || undefined }, { quoted: ctx.msg });
    },
  },
  {
    // .jail @user [30m|2h|1d]   (or reply to their message). No time = until .unjail
    name: 'jail', aliases: ['silence'], category: 'GROUP TOOLS', menu: ['jail @user [time]', 'unjail @user', 'jailed'],
    run: async (ctx) => {
      const info = await guard(ctx);
      if (!info) return;
      const targets = getTargets(ctx);
      if (!targets.length) return ctx.reply(`Tag who to jail, or reply to their message.\nExample: ${settings.prefix()}jail @user 2h`);
      const timeArg = ctx.args.find((a) => /^\d+\s*(?:m|min|h|hr|d|days?)$/i.test(a));
      const ms = timeArg ? parseJailTime(timeArg) : 0;
      if (timeArg && !ms) return ctx.reply('Time can be 1m to 7d. Example: 30m, 2h, 1d.');
      const g = (store.data.groups[ctx.jid] ||= {});
      const protectedIds = settings.protectedIds();
      const done = []; const skipped = [];
      for (const t of targets) {
        const n = numberOf(t);
        const part = info.meta.participants.find((p) => idsOf(p).includes(n));
        const ids = [...new Set([n, ...(part ? idsOf(part) : [])])];
        if (info.botNumbers.some((b) => ids.includes(b)) || ids.some((x) => settings.isOwner(x) || protectedIds.includes(x))) { skipped.push('me/owner'); continue; }
        if (ids.some((x) => info.admins.has(x))) { skipped.push('an admin'); continue; }
        if (Object.keys(g).length >= MAX_JAILED_PER_GROUP && !g[ids[0]]) { skipped.push('(jail is full)'); continue; }
        g[ids[0]] = { ids, until: ms ? Date.now() + ms : 0, by: ctx.senderNum, at: Date.now() };
        done.push(ids[0]);
      }
      store.save();
      if (!done.length) return ctx.reply(`Can't jail ${skipped[0] || 'them'}. Pick someone else.`);
      return ctx.sock.sendMessage(ctx.jid, {
          text: `Jailed ${done.map((d) => `@${d}`).join(', ')}${ms ? ` for ${fmt(ms)}` : ''}. Everything they send gets deleted.${skipped.length ? `\nSkipped: ${skipped.join(', ')}.` : ''}`,
          mentions: done.map((d) => `${d}@s.whatsapp.net`),
        }, { quoted: ctx.msg });
    },
  },
  {
    name: 'unjail', aliases: ['free', 'release'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const info = await groupInfo(ctx.sock, ctx.jid);
      if (!ctx.isOwner && !info.admins.has(ctx.senderNum)) return ctx.reply('Admins only.');
      const g = store.data.groups[ctx.jid] || {};
      if (/^all$/i.test(ctx.args[0] || '')) {
        const c = Object.keys(g).length; delete store.data.groups[ctx.jid]; store.save();
        return ctx.reply(c ? `Freed everyone (${c}).` : 'Nobody is jailed here.');
      }
      const targets = getTargets(ctx);
      if (!targets.length) return ctx.reply(`Tag who to free, or: ${settings.prefix()}unjail all`);
      let freed = 0;
      for (const t of targets) {
        const n = numberOf(t);
        for (const [k, rec] of Object.entries(g)) if (k === n || rec.ids.includes(n)) { delete g[k]; freed++; }
      }
      store.save();
      return ctx.reply(freed ? 'Freed. Behave.' : "They weren't jailed.");
    },
  },
  {
    name: 'jailed', aliases: ['jaillist'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const g = groupJail(ctx.jid);
      const rows = Object.entries(g).filter(([, r]) => !r.until || r.until > Date.now());
      if (!rows.length) return ctx.reply('Nobody is jailed here.');
      return ctx.sock.sendMessage(ctx.jid, {
        text: `Jailed here:\n${rows.map(([k, r]) => `• @${k}${r.until ? ` (${fmt(r.until - Date.now())} left)` : ''}`).join('\n')}`,
        mentions: rows.map(([k]) => `${k}@s.whatsapp.net`),
      }, { quoted: ctx.msg });
    },
  },
];
module.exports.check = check;
module.exports.parsePoll = parsePoll;
module.exports.jailRecord = jailRecord;
module.exports.init = () => store.load();
