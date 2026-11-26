// Favorite stickers with moods. The owner saves stickers (reply to one with .fav [mood]); in chat Lumi sometimes
// follows her answer with a favorite that matches the mood of the conversation: laugh, love, sad, angry, hype...
//   .fav [mood]          (owner) reply to a sticker. No mood = she looks at it and decides (needs a Gemini/Groq key), else "misc"
//   .favs [mood]         list favorites by mood          .sendfav [mood]   send one (no mood = random)
//   .unfav [id]          (owner) remove by id, or reply to the sticker           .favmood <id> <mood>  (owner) change a mood
//   .favmode on|off      (owner) let her use favorites in THIS chat on her own (on by default)
//   .favauto on|off      (owner) automatically save every sticker the OWNER sends her/the groups she is in
// Tuning: FAV_CHANCE (default 0.3 = about 1 in 3 fitting answers), FAV_COOLDOWN_MS (default 90000 per chat).
// Files live in DATA_DIR/stickers/fav, so attach a volume on Railway or they vanish on redeploy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');
const vision = require('./vision');
const { findMedia, download } = require('./helpers');
const { createStore } = require('./jsonStore');

const dir = path.join(config.dataDir, 'stickers', 'fav');
const store = createStore('favstickers', { items: [], auto: false, off: {} });
const MOODS = ['laugh', 'love', 'sad', 'angry', 'hype', 'shock', 'cool', 'thanks', 'greet', 'sleepy', 'misc'];
const MAX_TOTAL = 150, MAX_PER_MOOD = 20, MAX_BYTES = 1024 * 1024;
const fileOf = (id) => path.join(dir, `${id}.webp`);
const lastUse = new Map();   // chat -> time
const lastManual = new Map();

// ---------- mood of a message ----------
const MOOD_RULES = [
  ['sleepy', /😴|🥱|\b(good\s*night|goodnight|gn|sleep|sleepy|tired|bedtime)\b/i],
  ['laugh', /😂|🤣|💀|😆|\b(lol|lmao|lmfao|haha+|hehe+|funny|dead|i'?m dying|joke)\b/i],
  ['love', /😍|🥰|😘|❤️|💕|💖|🫶|\b(love you|i love|miss you|babe|baby|crush|cute|sweet|bae)\b/i],
  ['sad', /😢|😭|😔|🥺|💔|\b(sad|cry|crying|depressed|lonely|hurt|heartbroken|sorry to hear|feel bad)\b/i],
  ['angry', /😡|🤬|😤|\b(angry|furious|annoyed|mad at|pissed|hate this|useless)\b/i],
  ['shock', /😱|😮|🤯|😳|\b(omg|no way|wtf|what the|seriously|unbelievable|shocked|wow)\b/i],
  ['hype', /🔥|🎉|🥳|🙌|\b(let'?s go|lets go|congrat\w*|we won|won|winning|party|turn up|hype|yesss+|banger)\b/i],
  ['thanks', /🙏|\b(thanks|thank you|thx|appreciate|much love)\b/i],
  ['cool', /😎|👌|\b(cool|nice one|nice|smooth|clean|dope|lit|fire|mad)\b/i],
  ['greet', /👋|\b(hi|hello|hey|yo|good morning|good evening|good afternoon|sup|wassup|what'?s up)\b/i],
];
function moodOf(text) {
  const t = String(text || '');
  for (const [mood, re] of MOOD_RULES) if (re.test(t)) return mood;
  return null;
}

// ---------- storing ----------
const chance = () => { const n = parseFloat(process.env.FAV_CHANCE); return Number.isFinite(n) ? n : 0.3; };
const cooldown = () => { const n = parseInt(process.env.FAV_COOLDOWN_MS, 10); return Number.isFinite(n) ? n : 90000; };
const byMood = (mood) => store.data.items.filter((i) => i.mood === mood);
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function detectMood(buf, mime) {
  if (!vision.enabled()) return 'misc';
  try {
    const res = await vision.look(buf, mime, {
      system: 'You label WhatsApp stickers. Answer with ONE word only.',
      prompt: `What mood does this sticker express? Choose exactly one of: ${MOODS.filter((m) => m !== 'misc').join(', ')}. If none fits, answer misc.`,
      maxTokens: 10,
    });
    const word = (res && res.text || '').toLowerCase().match(/[a-z]+/g) || [];
    return word.find((w) => MOODS.includes(w)) || 'misc';
  } catch (_) { return 'misc'; }
}

// Save a sticker buffer. -> { item } | { error: 'dup'|'full'|'mood-full'|'big' }
async function add(buf, mime, { mood, by = '', animated = false } = {}) {
  if (!buf || !buf.length || buf.length > MAX_BYTES) return { error: 'big' };
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const dup = store.data.items.find((i) => i.hash === hash);
  if (dup) return { error: 'dup', item: dup };
  if (store.data.items.length >= MAX_TOTAL) return { error: 'full' };
  const m = MOODS.includes(mood) ? mood : await detectMood(buf, mime);
  if (byMood(m).length >= MAX_PER_MOOD) return { error: 'mood-full', mood: m };
  const id = (store.data.items.reduce((n, i) => Math.max(n, i.id), 0) || 0) + 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(id), buf);
  const item = { id, mood: m, hash, by, at: Date.now(), animated: Boolean(animated) };
  store.data.items.push(item); store.save();
  return { item };
}
function remove(id) {
  const i = store.data.items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  store.data.items.splice(i, 1); try { fs.unlinkSync(fileOf(id)); } catch (_) { /* gone */ } store.save();
  return true;
}
const readSticker = (item) => fs.readFileSync(fileOf(item.id));

// ---------- using ----------
// After Lumi answers: sometimes follow with a favorite matching the mood. Never in distress, never twice in a row too fast.
async function maybeSend(ctx, incomingText = '', answer = '') {
  try {
    if (ctx.paired || store.data.off[ctx.jid] || !store.data.items.length) return false;
    const mood = moodOf(incomingText) || moodOf(answer);
    if (!mood) return false;
    const pool = byMood(mood);
    if (!pool.length) return false;
    if (Math.random() >= chance()) return false;
    if (Date.now() - (lastUse.get(ctx.jid) || 0) < cooldown()) return false;
    lastUse.set(ctx.jid, Date.now());
    const item = pickRandom(pool);
    await new Promise((r) => setTimeout(r, require('./human').enabled() ? 700 + Math.random() * 1100 : 0));
    await ctx.sock.sendMessage(ctx.jid, { sticker: readSticker(item) });
    return true;
  } catch (e) { log.warn('favorite sticker failed:', e.message); return false; }
}

// The owner's own stickers are saved automatically while .favauto is on.
async function autoSave(sock, msg, ctx) {
  try {
    if (!store.data.auto || !ctx.isOwner || ctx.paired) return;
    const media = findMedia(msg, ['sticker']);
    if (!media || (Number(media.node.fileLength) || 0) > MAX_BYTES) return;
    const buf = await download(sock, media.source);
    await add(buf, media.node.mimetype || 'image/webp', { by: ctx.senderNum, animated: media.node.isAnimated });
  } catch (_) { /* best effort */ }
}

const moodList = () => MOODS.join(', ');

module.exports = [
  {
    name: 'fav', aliases: ['favsticker', 'favourite', 'favorite'], category: 'STICKER TOOLS', menu: ['fav [mood]'], ownerOnly: true,
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['sticker']);
      if (!media) return ctx.reply(`Reply to a sticker with ${settings.prefix()}fav, and add a mood if you want: ${moodList()}`);
      const given = (ctx.args[0] || '').toLowerCase();
      if (given && !MOODS.includes(given)) return ctx.reply(`I don't know the mood "${given}". Pick one of: ${moodList()}`);
      if ((Number(media.node.fileLength) || 0) > MAX_BYTES) return ctx.reply('That sticker is too big (1 MB max).');
      let buf; try { buf = await download(ctx.sock, media.source); } catch (_) { return ctx.reply("Couldn't download that sticker."); }
      const r = await add(buf, media.node.mimetype || 'image/webp', { mood: given, by: ctx.senderNum, animated: media.node.isAnimated });
      if (r.error === 'dup') return ctx.reply(`Already in my favorites (#${r.item.id}, ${r.item.mood}).`);
      if (r.error === 'full') return ctx.reply(`My favorites are full (${MAX_TOTAL}). Remove some with ${settings.prefix()}unfav.`);
      if (r.error === 'mood-full') return ctx.reply(`I already have ${MAX_PER_MOOD} "${r.mood}" stickers. Remove one or pick another mood.`);
      if (r.error) return ctx.reply("Couldn't save that one.");
      return ctx.reply(`Saved to favorites: #${r.item.id}, mood *${r.item.mood}* ⭐${given ? '' : '\n(Wrong mood? ' + settings.prefix() + 'favmood ' + r.item.id + ' <mood>)'}`);
    },
  },
  {
    name: 'favs', aliases: ['favorites', 'favourites'], category: 'STICKER TOOLS', menu: ['favs'],
    run: async (ctx) => {
      const items = store.data.items;
      if (!items.length) return ctx.reply(`No favorite stickers yet. Reply to a sticker with ${settings.prefix()}fav.`);
      const m = (ctx.args[0] || '').toLowerCase();
      if (m && MOODS.includes(m)) { const l = byMood(m); return ctx.reply(l.length ? `⭐ ${m} (${l.length}): ${l.map((i) => `#${i.id}`).join(' ')}` : `Nothing saved for "${m}".`); }
      const lines = MOODS.map((k) => [k, byMood(k).length]).filter(([, n]) => n).map(([k, n]) => `• ${k}: ${n}`);
      return ctx.reply(`⭐ Favorite stickers (${items.length}):\n${lines.join('\n')}\n\nSee one: ${settings.prefix()}sendfav <mood>`);
    },
  },
  {
    name: 'sendfav', aliases: ['favsend'], category: 'STICKER TOOLS', menu: [],
    run: async (ctx) => {
      if (!store.data.items.length) return ctx.reply('No favorite stickers yet.');
      if (!ctx.isOwner && Date.now() - (lastManual.get(ctx.jid) || 0) < 5000) return;
      const m = (ctx.args[0] || '').toLowerCase();
      if (m && !MOODS.includes(m)) return ctx.reply(`Moods: ${moodList()}`);
      const pool = m ? byMood(m) : store.data.items;
      if (!pool.length) return ctx.reply(`I don't have a "${m}" sticker yet.`);
      lastManual.set(ctx.jid, Date.now());
      return ctx.sock.sendMessage(ctx.jid, { sticker: readSticker(pickRandom(pool)) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'unfav', aliases: ['unfavorite', 'delfav'], category: 'STICKER TOOLS', menu: [], ownerOnly: true,
    run: async (ctx) => {
      let id = parseInt(String(ctx.args[0] || '').replace('#', ''), 10);
      if (!Number.isInteger(id)) {
        const media = findMedia(ctx.msg, ['sticker']);
        if (media) { try { const hash = crypto.createHash('sha1').update(await download(ctx.sock, media.source)).digest('hex'); const it = store.data.items.find((i) => i.hash === hash); if (it) id = it.id; } catch (_) { /* fall through */ } }
      }
      if (!Number.isInteger(id)) return ctx.reply(`Which one? ${settings.prefix()}unfav <id> (see ${settings.prefix()}favs), or reply to the sticker.`);
      return ctx.reply(remove(id) ? `Removed #${id} from favorites.` : `No favorite with id ${id}.`);
    },
  },
  {
    name: 'favmood', category: 'STICKER TOOLS', menu: [], ownerOnly: true,
    run: async (ctx) => {
      const id = parseInt(String(ctx.args[0] || '').replace('#', ''), 10); const m = (ctx.args[1] || '').toLowerCase();
      const it = store.data.items.find((i) => i.id === id);
      if (!it || !MOODS.includes(m)) return ctx.reply(`Use: ${settings.prefix()}favmood <id> <mood>\nMoods: ${moodList()}`);
      if (byMood(m).length >= MAX_PER_MOOD) return ctx.reply(`"${m}" is full (${MAX_PER_MOOD}).`);
      it.mood = m; store.save();
      return ctx.reply(`#${id} is now *${m}*.`);
    },
  },
  {
    name: 'favmode', category: 'STICKER TOOLS', menu: ['favmode on|off'], ownerOnly: true,
    run: async (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (a !== 'on' && a !== 'off') return ctx.reply(`Favorite stickers are ${store.data.off[ctx.jid] ? 'off' : 'on'} in this chat. Use ${settings.prefix()}favmode on or off.`);
      if (a === 'off') store.data.off[ctx.jid] = true; else delete store.data.off[ctx.jid];
      store.save();
      return ctx.reply(a === 'on' ? "Okay. I'll drop a sticker here when the mood fits." : "Okay. No stickers from me in this chat.");
    },
  },
  {
    name: 'favauto', category: 'STICKER TOOLS', menu: [], ownerOnly: true, mainOnly: true,
    run: async (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (a !== 'on' && a !== 'off') return ctx.reply(`Auto-saving your stickers is ${store.data.auto ? 'on' : 'off'}. Use ${settings.prefix()}favauto on or off.`);
      store.data.auto = a === 'on'; store.save();
      return ctx.reply(a === 'on' ? "Okay. Every sticker you send, I'll save to my favorites and work out its mood." : "Okay. I'll stop auto-saving your stickers.");
    },
  },
];
module.exports.init = () => store.load();
module.exports.maybeSend = maybeSend;
module.exports.autoSave = autoSave;
module.exports.moodOf = moodOf;
module.exports.MOODS = MOODS;
module.exports._store = store;
