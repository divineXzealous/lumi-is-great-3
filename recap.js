// .recap — what happened in a WhatsApp group. In the group, or from a private chat with her:
//   .recap                      the last 24 hours of THIS group (in a group)
//   .recap 6h | 2d | today | yesterday | all | 300     how far back (a number = that many messages, up to 800)
//   .recap                      (in a private chat, owner) lists the groups she has notes on
//   .recap 2 6h | .recap <group name> today            pick a group from the list or by name, then the range
// Long chats are summarised in parts and then combined, so nothing is dropped. She only knows what she SAW while in the group.
const chatlog = require('./chatlog');
const fallback = require('./fallback');
const settings = require('./settings');
const { numberOf } = require('./jid');
const { offlineReply } = require('./personality');

const cooldown = new Map(); // target group -> time of last recap
const CHUNK_CHARS = 5500;
const MAX_CHUNKS = 8;
const TZ = process.env.RECAP_TZ || 'Africa/Lagos';
const fmtTime = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const fmtDay = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(ts);
const fmtStamp = (ts) => `${fmtDay(ts)} ${fmtTime(ts)}`;
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${Math.max(1, m)}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

const SYSTEM_FINAL =
  'You write a recap of a WhatsApp group for someone who missed it. Sound like Lumi: dry and short, no fluff.\n' +
  'Format: first a headline line on what the group was about. Then bullet lines that each start with "• " covering ' +
  'what was discussed, who said or decided what, plans and dates, jokes worth knowing, arguments, and open questions. ' +
  'Use as many bullets as the chat needs (4 to 12), most important first. Name people. Plain text, no markdown, no intro, no outro. ' +
  'Only use what is in the chat; never invent details. Under 2200 characters. Write in the language the chat uses.';
const SYSTEM_PART =
  'You take notes on one part of a long WhatsApp group chat. List everything that matters as short lines starting with "• ": ' +
  'topics, who said or decided what, plans and dates, arguments, open questions. Keep names. Max 10 lines. Plain text, no intro. Never invent details.';

// "6h", "2d", "30m", "today", "yesterday", "all", "300"  ->  { count } | { since, label } | null
function parseRange(token) {
  const t = String(token || '').toLowerCase();
  let m;
  if ((m = t.match(/^(\d+)\s*(m|min|h|hr|d|day|days)$/))) {
    const n = parseInt(m[1], 10); const unit = m[2][0];
    const ms = n * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
    return { since: Date.now() - ms, label: `last ${n}${unit === 'm' ? ' min' : unit === 'h' ? 'h' : 'd'}` };
  }
  if (/^\d+$/.test(t)) return { count: Math.min(800, Math.max(10, parseInt(t, 10))), label: null };
  if (t === 'today') return { since: startOfDay(Date.now()), label: 'today' };
  if (t === 'yesterday') return { since: startOfDay(startOfDay(Date.now()) - 3600000), until: startOfDay(Date.now()), label: 'yesterday' };
  if (t === 'all' || t === 'everything') return { since: 0, label: 'everything I saw' };
  return null;
}
// Midnight (in TZ) of the day that `ts` falls on.
function tzOffsetMs(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ts).map((x) => [x.type, parseInt(x.value, 10)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
function startOfDay(ts) {
  const off = tzOffsetMs(ts); const local = new Date(ts + off);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off;
}

async function subjectOf(sock, jid) {
  if (chatlog.nameOf(jid) && chatlog.nameAge(jid) < 6 * 3600000) return chatlog.nameOf(jid);
  try { const meta = await sock.groupMetadata(jid); if (meta && meta.subject) { chatlog.setName(jid, meta.subject); return meta.subject; } } catch (_) { /* use the cached one */ }
  return chatlog.nameOf(jid) || 'a group';
}

async function isMember(sock, jid, ids) {
  try {
    const meta = await sock.groupMetadata(jid);
    return meta.participants.some((p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf).some((n) => ids.includes(n)));
  } catch (_) { return false; }
}

function statsLine(rows) {
  const by = new Map(); const kinds = { photo: 0, video: 0, sticker: 0, 'voice note': 0 };
  for (const r of rows) {
    by.set(r.name, (by.get(r.name) || 0) + 1);
    const k = (r.text.match(/^\[(photo|video|sticker|voice note)\]/) || [])[1]; if (k) kinds[k] += 1;
  }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(' · ');
  const media = Object.entries(kinds).filter(([, c]) => c).map(([k, c]) => `${c} ${k}${c > 1 ? 's' : ''}`).join(', ');
  return `_${rows.length} messages from ${by.size} ${by.size === 1 ? 'person' : 'people'}. Most active: ${top}.${media ? ` Shared: ${media}.` : ''}_`;
}

function chunk(rows) {
  const lines = rows.map((r) => `[${fmtTime(r.ts)}] ${r.name}: ${r.text}`);
  const parts = []; let cur = '';
  for (const l of lines) { if (cur.length + l.length + 1 > CHUNK_CHARS && cur) { parts.push(cur); cur = ''; } cur += (cur ? '\n' : '') + l; }
  if (cur) parts.push(cur);
  return parts;
}

async function summarise(rows, title) {
  let parts = chunk(rows); let skipped = 0;
  if (parts.length > MAX_CHUNKS) { skipped = parts.length - MAX_CHUNKS; parts = parts.slice(-MAX_CHUNKS); }
  let material;
  if (parts.length === 1) material = parts[0];
  else {
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      const r = await fallback.generate([{ role: 'system', content: SYSTEM_PART }, { role: 'user', content: `Part ${i + 1} of ${parts.length} of the chat "${title}":\n${parts[i]}` }]);
      if (!r) return null;
      notes.push(`Part ${i + 1}:\n${r.text.trim()}`);
    }
    material = notes.join('\n\n');
  }
  const res = await fallback.generate([
    { role: 'system', content: SYSTEM_FINAL },
    { role: 'user', content: `${parts.length > 1 ? `Notes taken part by part from the group "${title}" (oldest first):` : `Chat of the group "${title}" (oldest first):`}\n${material}` },
  ]);
  return res ? { text: res.text.trim().slice(0, 2600), skipped } : null;
}

module.exports = [
  {
    name: 'recap', aliases: ['summary'], category: 'GROUP TOOLS', menu: ['recap [group] [time]'],
    run: async (ctx) => {
      const args = [...ctx.args]; let range = null;
      // the last word may be the range ("6h", "today", "300")
      if (args.length && parseRange(args[args.length - 1])) range = parseRange(args.pop());
      const wantsList = !ctx.isGroup && !args.length;

      let jid = ctx.isGroup ? ctx.jid : null;
      let logKey = ctx.paired ? `p${ctx.paired.number}:` : '';
      if (!ctx.isGroup) {
        if (ctx.paired) return ctx.reply('Ask me in the group itself. Recaps from a private chat only work on my main number.');
        const known = chatlog.jids().filter((j) => !j.includes(':'));
        if (wantsList) {
          if (!ctx.isOwner) return ctx.reply(`Tell me which group: ${settings.prefix()}recap <group name> today`);
          if (!known.length) return ctx.reply("I haven't seen any group messages yet. I only keep notes while I'm in the group.");
          const rows = [];
          for (const j of known.sort((a, b) => chatlog.lastAt(b) - chatlog.lastAt(a))) rows.push({ j, name: await subjectOf(ctx.sock, j) });
          return ctx.reply(`Groups I have notes on:\n${rows.map((r, i) => `${i + 1}. ${r.name} (${chatlog.count(r.j)} msgs, last ${ago(Date.now() - chatlog.lastAt(r.j))})`).join('\n')}\n\nExample: ${settings.prefix()}recap 1 today\nOr: ${settings.prefix()}recap ${rows[0].name.split(/\s+/)[0].toLowerCase()} 6h`);
        }
        const pickText = args.join(' ').trim().toLowerCase();
        const byNum = /^\d+$/.test(pickText) ? parseInt(pickText, 10) : 0;
        const ordered = known.sort((a, b) => chatlog.lastAt(b) - chatlog.lastAt(a));
        if (byNum && ordered[byNum - 1]) jid = ordered[byNum - 1];
        else {
          const hits = [];
          for (const j of ordered) { const nm = await subjectOf(ctx.sock, j); if (nm.toLowerCase().includes(pickText)) hits.push(j); }
          if (hits.length > 1) return ctx.reply(`More than one group matches "${pickText}". Use the number from ${settings.prefix()}recap.`);
          jid = hits[0] || null;
        }
        if (!jid) return ctx.reply(`I don't have notes on a group like that. ${settings.prefix()}recap shows the list.`);
        logKey = '';
        if (!ctx.isOwner && !(await isMember(ctx.sock, jid, [ctx.senderNum]))) return ctx.reply("You're not in that group, so no recap for you.");
      }

      const key = logKey + jid;
      range = range || { since: Date.now() - 86400000, label: 'last 24h' };
      let rows = range.count ? chatlog.last(key, range.count) : chatlog.since(key, range.since);
      if (range.until) rows = rows.filter((r) => r.ts < range.until);
      if (rows.length < 5) return ctx.reply(`Not enough to recap${range.label ? ` for ${range.label}` : ''} (${rows.length} message${rows.length === 1 ? '' : 's'}). I only keep what I saw while in the group.${chatlog.firstAt(key) ? ` My notes start ${fmtStamp(chatlog.firstAt(key))}. Try a longer range like ${settings.prefix()}recap 3d.` : ''}`);
      if (!ctx.isOwner && Date.now() - (cooldown.get(key) || 0) < 30000) return ctx.reply('I just did one. Give it 30 seconds.');
      if (!ctx.isOwner) cooldown.set(key, Date.now());

      const title = await subjectOf(ctx.sock, jid);
      await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
      let out;
      try { out = await summarise(rows, title); } finally { await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {}); }
      if (!out) return ctx.reply(offlineReply());
      const span = `${fmtStamp(rows[0].ts)} to ${fmtStamp(rows[rows.length - 1].ts)}`;
      const warn = out.skipped ? `\n_(It was a lot, so the oldest part was skipped. Try a shorter range for that part.)_` : '';
      const early = !range.count && range.since && chatlog.firstAt(key) && chatlog.firstAt(key) > range.since + 3600000 ? `\n_(I only have notes from ${fmtStamp(chatlog.firstAt(key))}. I can't see older messages.)_` : '';
      return ctx.reply(`*Recap: ${title}*${range.label ? ` (${range.label})` : ''}\n_${span}_\n\n${out.text}\n\n${statsLine(rows)}${early}${warn}`);
    },
  },
];
