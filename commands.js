// commands.js - LUMI command handler (single file, Baileys, CommonJS)
// Rebuilt from the full Lumi project. Owner: Divine.
//
// Install:  npm i @whiskeysockets/baileys sharp
// Optional: npm i wa-sticker-formatter ffmpeg-static   (video stickers, .tomp3, animated .toimg)
//
// Wire it into your messages.upsert handler:
//
//   const lumi = require('./commands');
//   lumi.configure({
//     generate: async (messages) => ({ text: '...' }), // your AI call (used by .recap), optional
//     clearMemory: (userNum) => {},                    // wipe stored AI history (used by .clear), optional
//     onAiChat: (userNum) => {},                       // called after each AI chat, optional
//   });
//   sock.ev.on('messages.upsert', async ({ messages }) => {
//     const msg = messages[0];
//     if (await lumi.handleCommand(sock, msg)) return;          // command, AFK, sleep or Divine protection
//     if (lumi.shouldChat(sock, msg)) { /* your existing AI reply code */ }
//   });
//
// Env (all optional): PREFIX, OWNER_NAME, OWNER_NUMBER, OWNER_SHOW_NUMBER, CLAIM_PASSPHRASE,
// PROTECTED_CONTACT_ID, PROTECTED_ENABLED, PROTECTED_COOLDOWN_MS, STICKER_PACK, STICKER_AUTHOR,
// MUSIC_COUNTRY, COBALT_API_URL, COBALT_API_KEY, DL_MAX_MB, PERSONALITY (warm|maki|calm), DATA_DIR.
// Personality of the AI chat itself lives in personality.js / annoy.js of the full project; this file only
// uses it for the menu and .about text.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');
const { downloadMediaMessage, downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

// ---------- config ----------

const digits = (v) => String(v || '').replace(/\D/g, '');
const idList = (v) => String(v || '').split(',').map(digits).filter(Boolean);
const flag = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const CONFIG = {
  botName: 'Lumi',
  version: '1.1.0',
  prefix: process.env.PREFIX || '.',
  dataDir: process.env.DATA_DIR || 'data',
  claimPassphrase: process.env.CLAIM_PASSPHRASE || '',
  personality: (process.env.PERSONALITY || 'warm').toLowerCase(),
  ownerName: process.env.OWNER_NAME || 'Divine',
  ownerIds: idList(process.env.OWNER_NUMBER || '2347075369608'),
  showOwnerNumber: flag(process.env.OWNER_SHOW_NUMBER, false),
  protectedIds: idList(process.env.PROTECTED_CONTACT_ID),
  protectedEnabled: flag(process.env.PROTECTED_ENABLED, true),
  protectedCooldownMs: parseInt(process.env.PROTECTED_COOLDOWN_MS, 10) || 30000,
  stickerPack: process.env.STICKER_PACK || 'Lumi',
  stickerAuthor: process.env.STICKER_AUTHOR || 'Made by Lumi',
  musicCountry: process.env.MUSIC_COUNTRY || 'US',
  cobaltUrl: (process.env.COBALT_API_URL || '').trim(),
  cobaltKey: (process.env.COBALT_API_KEY || '').trim(),
  dlMaxBytes: (parseInt(process.env.DL_MAX_MB, 10) || 60) * 1024 * 1024,
};
const label = () => (CONFIG.personality === 'calm' ? 'Nonchalant.' : CONFIG.personality === 'maki' ? 'Blunt & nonchalant.' : 'Warm. Bites back.');

// Hooks the host app can plug in (all optional).
const hooks = { generate: null, clearMemory: null, onAiChat: null };
function configure(h = {}) { Object.assign(hooks, h); }

// ---------- tiny json store ----------

const NOOP_LOG = { level: 'silent', child() { return NOOP_LOG; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const warn = (...a) => console.warn('[lumi]', ...a);

const STORE_FILE = path.join(CONFIG.dataDir, 'commands.json');
const store = { aiOff: {}, protectEnabled: null, claimed: [], protectAlias: [], subOwners: [], prefix: null, afk: {}, sleeping: {}, affinity: {}, wins: {}, voiceName: null, jail: {}, stickers: {}, social: { users: {}, proposals: {} }, autoread: 'on', favs: { items: [], auto: false, off: {} }, persona: {}, blocked: {}, chatlog: { chats: {}, names: {} } };
try {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
} catch (_) { /* first run */ }
let saveTimer = null;
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) { warn('could not save settings:', e.message); }
}
function save() { if (!saveTimer) { saveTimer = setTimeout(flush, 1500); saveTimer.unref && saveTimer.unref(); } }
process.on('exit', () => { try { if (saveTimer) flush(); } catch (_) {} });

// ---------- settings (owners, prefix, AI switch, sleep, AFK, affinity) ----------

const uniq = (a) => [...new Set(a)];
const numberOf = (jid) => String(jid || '').split('@')[0].split(':')[0];

const S = {
  prefix: () => store.prefix || CONFIG.prefix,
  setPrefix(p) { store.prefix = p && p !== CONFIG.prefix ? p : null; save(); },
  isAiOn: (chat) => !store.aiOff[chat],
  setAi(chat, on) { if (on) delete store.aiOff[chat]; else store.aiOff[chat] = true; save(); },
  isProtectOn: () => (store.protectEnabled === null ? CONFIG.protectedEnabled : store.protectEnabled),
  setProtect(on) { store.protectEnabled = Boolean(on); save(); },
  isMainOwner: (n) => CONFIG.ownerIds.includes(n) || store.claimed.includes(n),
  isSubOwner: (n) => store.subOwners.includes(n),
  isOwner: (n) => S.isMainOwner(n) || S.isSubOwner(n),
  addSubOwners(nums) {
    const before = store.subOwners.length;
    store.subOwners = uniq([...store.subOwners, ...nums.filter((n) => n && !S.isMainOwner(n))]);
    if (store.subOwners.length !== before) save();
    return store.subOwners.length - before;
  },
  removeSubOwners(nums) {
    const before = store.subOwners.length;
    store.subOwners = store.subOwners.filter((n) => !nums.includes(n));
    if (store.subOwners.length !== before) save();
    return before - store.subOwners.length;
  },
  addClaimed(nums) {
    const before = store.claimed.length;
    store.claimed = uniq([...store.claimed, ...nums.filter(Boolean)]);
    if (store.claimed.length !== before) save();
    return store.claimed.length !== before;
  },
  clearClaimed() { store.claimed = []; store.protectAlias = []; save(); },
  addProtectAlias(nums) {
    const before = store.protectAlias.length;
    store.protectAlias = uniq([...store.protectAlias, ...nums.filter(Boolean)]);
    if (store.protectAlias.length !== before) save();
  },
  protectedIds: () => uniq([...CONFIG.protectedIds, ...store.claimed, ...store.protectAlias]),
  isAsleep: (chat) => Boolean(store.sleeping[chat]),
  setSleep(chat, on) { if (on) store.sleeping[chat] = true; else delete store.sleeping[chat]; save(); },
  getAfk: (n) => store.afk[n] || null,
  setAfk(n, info) { store.afk[n] = info; save(); },
  clearAfk(n) { delete store.afk[n]; save(); },
};

// ---------- affinity + game wins ----------

const LEVELS = [[0, 'stranger'], [10, 'tolerated'], [40, 'familiar'], [100, 'trusted'], [200, 'favorite']];
const lastGain = new Map();
function getAffinity(num) {
  const pts = store.affinity[num] || 0;
  let cur = LEVELS[0], next = null;
  for (let i = 0; i < LEVELS.length; i++) if (pts >= LEVELS[i][0]) { cur = LEVELS[i]; next = LEVELS[i + 1] || null; }
  return { pts, level: cur[1], next: next ? { level: next[1], need: next[0] - pts } : null };
}
function gainAffinity(num, n = 1) { // +1 per AI conversation, max once per 30 s per person
  if (!num) return 0;
  const now = Date.now();
  if (now - (lastGain.get(num) || 0) < 30000) return getAffinity(num).pts;
  lastGain.set(num, now);
  store.affinity[num] = Math.min(1000, (store.affinity[num] || 0) + n);
  save();
  return store.affinity[num];
}
function resetAffinity(nums) {
  let c = 0;
  for (const n of nums) { lastGain.delete(n); if (store.affinity[n] !== undefined) { delete store.affinity[n]; c++; } }
  if (c) save();
  return c;
}
function resetAllAffinity() { const c = Object.keys(store.affinity).length; store.affinity = {}; lastGain.clear(); save(); return c; }
function addWin(num, name) {
  if (!num) return;
  const w = store.wins[num] || (store.wins[num] = { n: 0, name: '' });
  w.n += 1;
  if (name) w.name = name;
  save();
}
const topWins = (k = 10) => Object.entries(store.wins).map(([num, w]) => ({ num, name: w.name, n: w.n })).sort((a, b) => b.n - a.n).slice(0, k);

// ---------- small helpers ----------

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${sec % 60}s`;
}

// Peel off wrappers (disappearing messages, view-once, etc.)
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage;
    if (!inner) break;
    m = inner.message;
  }
  return m;
}
const getText = (m) => (m ? m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '' : '');
function getContext(m) {
  if (!m) return null;
  for (const v of Object.values(m)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  return null;
}
function findMedia(msg, kinds) {
  const pickKind = (m) => { for (const k of kinds) if (m?.[`${k}Message`]) return { kind: k, node: m[`${k}Message`] }; return null; };
  const m = unwrap(msg.message);
  const own = pickKind(m);
  if (own) return { ...own, source: { key: msg.key, message: msg.message } };
  const ci = getContext(m);
  if (ci?.quotedMessage) {
    const found = pickKind(unwrap(ci.quotedMessage));
    if (found) return { ...found, source: { key: { remoteJid: msg.key.remoteJid, id: ci.stanzaId, participant: ci.participant }, message: ci.quotedMessage } };
  }
  return null;
}
const downloadMedia = (sock, source) => downloadMediaMessage(source, 'buffer', {}, { logger: NOOP_LOG, reuploadRequest: sock.updateMediaMessage });

// Every id WhatsApp gives us for this sender (phone number and/or hidden LID).
function senderIds(msg) {
  const k = msg.key;
  return [k.participant, k.participantAlt, k.participantPn, k.remoteJidAlt, k.remoteJid]
    .filter((j) => j && (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid'))).map(numberOf);
}
// Who does a command point at? @mentions, else the replied-to person, plus typed numbers.
function targetNumbers(ctx) {
  const out = new Set(ctx.mentioned.map(numberOf));
  ctx.args.map((a) => a.replace(/\D/g, '')).filter((x) => x.length >= 7 && x.length <= 15).forEach((x) => out.add(x));
  if (!out.size && ctx.ctxInfo?.participant) out.add(numberOf(ctx.ctxInfo.participant));
  return [...out].filter(Boolean);
}
// "5s", "2m", "1h" (or "5" = seconds). Between 1 second and 6 hours.
function parseDuration(a) {
  const m = /^(\d+)\s*(s|sec|m|min|h|hr)?$/i.exec(String(a || '').trim());
  if (!m) return null;
  const unit = (m[2] || 's').toLowerCase();
  const ms = parseInt(m[1], 10) * (unit.startsWith('h') ? 3600000 : unit.startsWith('m') ? 60000 : 1000);
  return ms >= 1000 && ms <= 6 * 3600000 ? ms : null;
}

async function groupInfo(sock, jid) {
  const meta = await sock.groupMetadata(jid);
  const nums = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf);
  const admins = new Set(meta.participants.filter((p) => p.admin).flatMap(nums));
  const botNumbers = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf);
  return { meta, admins, botNumbers, botIsAdmin: botNumbers.some((b) => admins.has(b)) };
}
async function adminGuard(ctx, { needBotAdmin = true } = {}) {
  if (!ctx.isGroup) { await ctx.reply('Groups only.'); return null; }
  const info = await groupInfo(ctx.sock, ctx.jid);
  if (!ctx.isOwner && !info.admins.has(ctx.senderNum)) { await ctx.reply('Admins only.'); return null; }
  if (needBotAdmin && !info.botIsAdmin) { await ctx.reply("Make me an admin first. I can't do that otherwise."); return null; }
  return info;
}

// promote / demote share everything except the action and the wording.
async function updateMembers(ctx, action, done, usage) {
  const info = await adminGuard(ctx);
  if (!info) return;
  const targets = uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
  if (!targets.length) return ctx.reply(usage);
  if (action === 'demote') {
    const prot = S.protectedIds();
    if (targets.some((j) => { const n = numberOf(j); return info.botNumbers.includes(n) || S.isOwner(n) || prot.includes(n); })) {
      return ctx.reply('Not him. Not me either. Pick someone else.');
    }
  }
  const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, action);
  const failed = (res || []).filter((r) => String(r.status) !== '200');
  return ctx.reply(failed.length ? "Couldn't do it for everyone. WhatsApp said no." : done);
}
const groupSetting = (name, value, done) => ({
  name, category: 'GROUP TOOLS', menu: [name],
  run: async (ctx) => {
    if (!(await adminGuard(ctx))) return;
    await ctx.sock.groupSettingUpdate(ctx.jid, value);
    return ctx.reply(done);
  },
});

async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, as = 'json' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
    return as === 'text' ? res.text() : res.json();
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('timeout'); t.status = 'timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- ffmpeg (optional) ----------

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) { try { ffmpegPath = require('ffmpeg-static'); } catch (_) {} }
if (!ffmpegPath) { try { if (require('child_process').spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0) ffmpegPath = 'ffmpeg'; } catch (_) {} }
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

async function ffmpeg(buf, inName, outName, args) {
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lumi-'));
  const inp = path.join(dir, inName), out = path.join(dir, outName);
  try {
    await fs.promises.writeFile(inp, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inp, ...args, out]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
    });
    return await fs.promises.readFile(out);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const gifToMp4 = (buf) => ffmpeg(buf, 'in.gif', 'out.mp4', ['-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']);
const toVoiceNote = (buf) => ffmpeg(buf, 'in.bin', 'out.ogg', ['-vn', '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-application', 'voip']);
const toMp3 = (buf) => ffmpeg(buf, 'in.bin', 'out.mp3', ['-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k']);

// ---------- Lumi's voice ----------

const DIVINE_REPLIES = [
  'Stop tagging my babe he is busy with me',
  'Kain, stop that shii or face my wrath',
  'Tf, did he tell you he will not reply?',
];
const DIVINE_REACTIONS = []; // reactions are off: she only replies
let lastDivine = -1;
const divineFired = new Map();

// A plain reply to someone is not a tag of them: with no "@" in the text, drop the replied-to person from the mentions.
function realTags(ctxInfo, text) {
  const list = ctxInfo?.mentionedJid || [];
  if (!ctxInfo?.participant || String(text || '').includes('@')) return list;
  const replyTo = numberOf(ctxInfo.participant);
  return list.filter((j) => numberOf(j) !== replyTo);
}

function divineCheck(ctx) {
  const ids = S.protectedIds();
  if (!ctx.isGroup || !ids.length || !S.isProtectOn()) return null;
  if (!(ctx.taggedJids || ctx.mentioned).map(numberOf).some((n) => ids.includes(n))) return null;
  if (ids.includes(ctx.senderNum)) return null; // Divine tagging himself
  const now = Date.now();
  if (now - (divineFired.get(ctx.jid) || 0) < CONFIG.protectedCooldownMs) return null;
  divineFired.set(ctx.jid, now);
  let i;
  do { i = rnd(DIVINE_REPLIES.length); } while (i === lastDivine);
  lastDivine = i;
  return { reply: DIVINE_REPLIES[i], emoji: DIVINE_REACTIONS.length ? pick(DIVINE_REACTIONS) : null };
}

const SLEEP_LINE = "Fine. I'm out. Wake me with 'lumi assemble' when you need me.";
const SLEEP_RE = /^\s*(?:hey\s+)?lumi[\s,:;-]+vanish(?:\s+now)?\s*[.!]*\s*$/i;
const WAKE_RE = /^\s*(?:hey\s+)?lumi[\s,:;-]+assemble\s*[.!]*\s*$/i;

// ---------- sent-message tracking (a reply to one of these is a reply to Lumi) ----------

const sentIds = new Map();
const extraBotIds = new Set();
const wrapped = new WeakSet();
function trackSent(sock) {
  if (wrapped.has(sock)) return;
  wrapped.add(sock);
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await original(...args);
    const id = res?.key?.id;
    if (id) {
      sentIds.set(id, Date.now());
      if (sentIds.size > 1000) for (const k of sentIds.keys()) { sentIds.delete(k); if (sentIds.size <= 800) break; }
    }
    return res;
  };
}
const botNumbers = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf).concat([...extraBotIds]);

function isAddressed(ctx) {
  if (!ctx.isGroup) return true;
  if (/\blumi\b/i.test(ctx.text)) return true;
  const quotedId = ctx.ctxInfo?.stanzaId;
  if (quotedId && sentIds.has(quotedId)) {
    if (ctx.ctxInfo.participant) extraBotIds.add(numberOf(ctx.ctxInfo.participant));
    return true;
  }
  const bots = botNumbers(ctx.sock);
  if (ctx.mentioned.some((j) => bots.includes(numberOf(j)))) return true;
  return Boolean(ctx.ctxInfo?.participant && bots.includes(numberOf(ctx.ctxInfo.participant)));
}

// WhatsApp may show one person as a phone number AND a hidden id (LID): remember both.
function learnAliases(msg) {
  const uniqIds = uniq(senderIds(msg));
  if (uniqIds.length < 2) return;
  if (uniqIds.some(S.isMainOwner)) S.addClaimed(uniqIds);
  else if (uniqIds.some(S.isSubOwner)) S.addSubOwners(uniqIds);
  else if (uniqIds.some((n) => S.protectedIds().includes(n))) S.addProtectAlias(uniqIds);
}

// ---------- group log (for .recap: works from the group or from a private chat with the owner) ----------
// Saved in the store: text cut to 240 chars, 800 entries per group, 40 groups, last RECAP_KEEP_DAYS days (default 7).
// RECAP_PERSIST=off keeps it in memory only. She only knows what she SAW while in the group.
const CL_MAX = 800, CL_CHATS = 40, CL_TEXT = 240;
const clKeepMs = () => { const d = parseFloat(process.env.RECAP_KEEP_DAYS); return (Number.isFinite(d) && d > 0 ? d : 7) * 86400000; };
let clTimer = null;
function clSchedule() { if (/^(0|false|off|no)$/i.test(process.env.RECAP_PERSIST || 'on') || clTimer) return; clTimer = setTimeout(() => { clTimer = null; save(); }, 30000); clTimer.unref && clTimer.unref(); }
const clChats = () => ((store.chatlog ||= { chats: {}, names: {} }).chats ||= {});
function describeMsg(m, text = '') {
  const cap = String(text || '').trim(); const tag = (l) => (cap ? `[${l}] ${cap}` : `[${l}]`);
  if (!m) return cap || null;
  if (m.imageMessage) return tag('photo');
  if (m.videoMessage) return tag(m.videoMessage.gifPlayback ? 'gif' : 'video');
  if (m.stickerMessage) return '[sticker]';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.documentMessage) return `[file] ${m.documentMessage.fileName || ''}${cap ? ' ' + cap : ''}`.trim();
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3; if (poll) return `[poll] ${poll.name || ''}`.trim();
  if (m.contactMessage || m.contactsArrayMessage) return '[contact]';
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  return cap || null;
}
function logChat(jid, name, text) {
  if (!text) return;
  const c = clChats(); let l = c[jid];
  if (!l) {
    const keys = Object.keys(c);
    if (keys.length >= CL_CHATS) { const o = keys.sort((x, y) => ((c[x][c[x].length - 1] || [0])[0]) - ((c[y][c[y].length - 1] || [0])[0]))[0]; delete c[o]; delete store.chatlog.names[o]; }
    l = c[jid] = [];
  }
  l.push([Date.now(), String(name || 'Someone').slice(0, 40), String(text).replace(/\s+/g, ' ').slice(0, CL_TEXT)]);
  if (l.length > CL_MAX) l.splice(0, l.length - CL_MAX);
  clSchedule();
}
const clFresh = (jid) => { const cut = Date.now() - clKeepMs(); return (clChats()[jid] || []).filter((r) => r[0] >= cut); };
const clRows = (rows) => rows.map((r) => ({ ts: r[0], name: r[1], text: r[2] }));
const clLast = (jid, n) => clRows(clFresh(jid).slice(-n));
const clSince = (jid, ts) => clRows(clFresh(jid).filter((r) => r[0] >= ts));
const clJids = () => Object.keys(clChats()).filter((j) => clFresh(j).length);
const clLastAt = (jid) => { const l = clFresh(jid); return l.length ? l[l.length - 1][0] : 0; };
const clFirstAt = (jid) => (clFresh(jid)[0] || [null])[0];

// ---------- stickers ----------

let Fancy = null;
try { Fancy = require('wa-sticker-formatter'); } catch (_) { /* optional */ }
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* optional */ }

const MAX_IMAGE = 10 * 1024 * 1024, MAX_VIDEO = 15 * 1024 * 1024, MAX_SECONDS = 10;
const MAX_STATIC = 100 * 1024, MAX_ANIMATED = 1024 * 1024;
const sizeOf = (node) => Number(node.fileLength) || 0;

async function liteSticker(buf) {
  const SZ = 512;
  const mask = Buffer.from(`<svg width="${SZ}" height="${SZ}"><rect width="${SZ}" height="${SZ}" rx="96" ry="96" fill="#fff"/></svg>`);
  for (const quality of [85, 65, 45, 30]) {
    const out = await sharp(buf).resize(SZ, SZ, { fit: 'cover', position: sharp.strategy.attention })
      .composite([{ input: mask, blend: 'dest-in' }]).webp({ quality }).toBuffer();
    if (out.length <= MAX_STATIC) return out;
  }
  return null;
}
async function fancySticker(buf, pack, author) {
  for (const quality of [70, 50, 30]) {
    const s = new Fancy.Sticker(buf, { pack: pack || CONFIG.stickerPack, author: author || CONFIG.stickerAuthor, type: Fancy.StickerTypes.ROUNDED, quality, background: 'transparent' });
    const out = await s.toBuffer();
    if (out.length <= MAX_ANIMATED) return out;
  }
  return null;
}

async function makeSticker(ctx) {
  const media = findMedia(ctx.msg, ['image', 'video']);
  if (!media) return ctx.reply(`Reply to an image with ${S.prefix()}s`);
  if (media.kind === 'image' && sizeOf(media.node) > MAX_IMAGE) return ctx.reply('That image is too big (10 MB max).');
  if (media.kind === 'video') {
    if (!Fancy) return ctx.reply("Video stickers aren't enabled on this server. Images work.");
    if (sizeOf(media.node) > MAX_VIDEO) return ctx.reply('That video is too big (15 MB max).');
    if ((media.node.seconds || 0) > MAX_SECONDS) return ctx.reply(`Videos must be ${MAX_SECONDS} seconds or less.`);
  }
  if (!Fancy && !sharp) return ctx.reply("I can't make stickers on this server (sharp is missing).");
  const buf = await downloadMedia(ctx.sock, media.source);
  const out = media.kind === 'video' || Fancy ? await fancySticker(buf) : await liteSticker(buf);
  if (!out) return ctx.reply("Couldn't squeeze that under WhatsApp's sticker size limit.");
  return ctx.sock.sendMessage(ctx.jid, { sticker: out }, { quoted: ctx.msg });
}

// .toimg  (sticker -> image).  .take  (same, or `.take pack|author` re-stamps the sticker)
async function stickerToImage(ctx) {
  const media = findMedia(ctx.msg, ['sticker']);
  if (!media) return ctx.reply('Reply to a sticker first.');
  const buf = await downloadMedia(ctx.sock, media.source);
  if (media.node.isAnimated) {
    try {
      const gif = await sharp(buf, { animated: true }).gif().toBuffer();
      return ctx.sock.sendMessage(ctx.jid, { video: await gifToMp4(gif), gifPlayback: true }, { quoted: ctx.msg });
    } catch (_) { return ctx.reply("I can't convert animated stickers on this server. Static ones work."); }
  }
  if (!sharp) return ctx.reply("I can't convert that on this server (sharp is missing).");
  return ctx.sock.sendMessage(ctx.jid, { image: await sharp(buf).png().toBuffer() }, { quoted: ctx.msg });
}
async function takeSticker(ctx) {
  if (!ctx.argText) return stickerToImage(ctx);
  if (!Fancy) return ctx.reply("Renaming stickers isn't enabled on this server.");
  const media = findMedia(ctx.msg, ['sticker']);
  if (!media) return ctx.reply(`Reply to a sticker. Usage: ${S.prefix()}take pack|author`);
  const [pack, author] = ctx.argText.split('|').map((x) => x.trim());
  const out = await fancySticker(await downloadMedia(ctx.sock, media.source), pack, author);
  if (!out) return ctx.reply("Couldn't squeeze that under WhatsApp's sticker size limit.");
  return ctx.sock.sendMessage(ctx.jid, { sticker: out }, { quoted: ctx.msg });
}

// ---------- music (.play) : full song via YouTube + cobalt (same downloader as .dl); 30 s preview as fallback ----------
// Needs COBALT_API_URL for full songs. PLAY_MAX_SECONDS (default 600) caps the song length.
const PLAY_MAX_SECONDS = () => parseInt(process.env.PLAY_MAX_SECONDS, 10) || 600;
const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BAD_WORDS = /\b(cover|karaoke|instrumental|remix|slowed|sped up|reverb|8d|nightcore|reaction|tutorial|lesson)\b/i;

// "3:45" / "1:02:10" -> seconds
const toSeconds = (t) => String(t || '').split(':').map(Number).reduce((a, n) => a * 60 + (Number.isFinite(n) ? n : 0), 0);

// Pull the video results out of YouTube's search page.
function parseYoutube(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html) || /ytInitialData"\]\s*=\s*(\{.*?\});/s.exec(html);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({
        id: v.videoId,
        title: (v.title && v.title.runs && v.title.runs.map((r) => r.text).join('')) || '',
        channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '',
        seconds: toSeconds(v.lengthText && v.lengthText.simpleText), // 0 = live stream
      });
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return out;
}

// Best match: right length, not a cover/remix/karaoke (unless asked for), prefers the artist's own channel.
function pickVideo(videos, { query = '', artist = '', targetSeconds = 0, maxSeconds = 600 }) {
  let best = null;
  for (const v of videos) {
    if (!v.seconds || v.seconds < 60 || v.seconds > maxSeconds) continue;
    let score = targetSeconds ? Math.abs(v.seconds - targetSeconds) : Math.abs(v.seconds - 210);
    if (targetSeconds && Math.abs(v.seconds - targetSeconds) > 25) score += 500; // wrong version
    if (BAD_WORDS.test(v.title) && !BAD_WORDS.test(query)) score += 1000;
    if (artist && v.channel.toLowerCase().includes(artist.toLowerCase().split(/[,&]/)[0].trim())) score -= 20;
    if (/official/i.test(v.title) || /topic$/i.test(v.channel)) score -= 10;
    if (!best || score < best.score) best = { ...v, score };
  }
  return best && best.score < 500 ? best : null;
}

async function searchYoutube(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`;
  const html = await http(url, { as: 'text', headers: { 'user-agent': PLAY_UA, 'accept-language': 'en-US,en;q=0.9' }, timeoutMs: 15000 });
  return parseYoutube(html);
}

const playBusy = new Set();
async function play(ctx) {
  const q = ctx.argText;
  if (!q) return ctx.reply(`Tell me what to look for. Example: ${S.prefix()}play artist - song`);
  if (playBusy.has(ctx.jid)) return ctx.reply('Still working on the last song. One at a time.');
  playBusy.add(ctx.jid);
  try { await playSong(ctx, q); } finally { playBusy.delete(ctx.jid); }
}
async function playSong(ctx, q) {
  await ctx.sock.sendMessage(ctx.jid, { react: { text: '🎧', key: ctx.msg.key } }).catch(() => {});

  // 1) song info (optional: if iTunes finds nothing we still try YouTube with the raw text)
  let t = null;
  try {
    const data = await http(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=1&country=${CONFIG.musicCountry}`, { timeoutMs: 15000 });
    t = data && data.results && data.results[0];
  } catch (e) { warn('iTunes search failed:', e.message); }

  const title = t ? t.trackName : q;
  const artist = t ? t.artistName : '';
  const target = t && t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : 0;
  const maxSeconds = PLAY_MAX_SECONDS();

  // 2) find the full audio
  let audio = null; let why = '';
  if (target > maxSeconds) why = `That one is ${Math.round(target / 60)} minutes long, over my ${Math.round(maxSeconds / 60)}-minute limit.`;
  else {
    try {
      const video = pickVideo(await searchYoutube(`${artist} ${title} audio`.trim()), { query: q, artist, targetSeconds: target, maxSeconds });
      if (!video) why = "I couldn't find a good full version of that song.";
      else {
        const [f] = await resolveLink(`https://www.youtube.com/watch?v=${video.id}`, true);
        const file = await fetchFile(f.url);
        if (file.type === 'text/html') throw new Error('not audio');
        audio = { buf: file.buf, mimetype: file.type.startsWith('audio/') ? file.type : 'audio/mpeg', video };
      }
    } catch (e) {
      warn(`play: full song failed: ${e.message}`);
      why = e.noService
        ? "Full songs need a downloader set up on my server (COBALT_API_URL)."
        : e.message === 'too big' ? "That song's file is too big to send." : "Couldn't download the full song right now.";
    }
  }

  // 3) the card: cover, names, links
  const name = t ? `*${t.trackName}*\n${t.artistName}${t.collectionName ? `\nAlbum: ${t.collectionName}` : ''}` : `*${q}*`;
  const links = t ? `\n\nListen: ${t.trackViewUrl}` : '';
  const caption = `${name}${links}${audio ? '' : `\n\n${why} ${t && t.previewUrl ? 'Sending a 30-second preview instead.' : ''}`}`.trim();
  if (t && t.artworkUrl100) {
    try {
      const img = await http(t.artworkUrl100.replace('100x100', '600x600'), { as: 'buffer', timeoutMs: 15000 });
      await ctx.sock.sendMessage(ctx.jid, { image: img, caption }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply(caption); }
  } else await ctx.reply(caption);

  // 4) the song
  if (audio) {
    try { return await ctx.sock.sendMessage(ctx.jid, { audio: audio.buf, mimetype: audio.mimetype, ptt: false }, { quoted: ctx.msg }); }
    catch (e) { warn('play: sending audio failed:', e.message); }
  }
  if (t && t.previewUrl) {
    try {
      const preview = await http(t.previewUrl, { as: 'buffer', timeoutMs: 20000 });
      await ctx.sock.sendMessage(ctx.jid, { audio: preview, mimetype: 'audio/mp4', ptt: false }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply("The preview wouldn't load either. Try the link above."); }
  } else if (!audio) await ctx.reply(t ? "No audio available. Use the link above." : "I couldn't find that one. Try 'artist - song'.");
}

// ---------- voice notes (.voice) : Google Translate text-to-speech -> WhatsApp voice note ----------

const VOICE_LANGS = new Set(['en', 'fr', 'es', 'de', 'pt', 'it', 'hi', 'ar', 'sw', 'ja', 'ko', 'zh', 'ru', 'tr', 'nl', 'id']);
const voiceUse = new Map();
let lastCreateAt = 0;
function speakable(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, ' link ').replace(/[*_~`#>|]/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function chunkText(text, size = 180) {
  const out = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const s of text.match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [text]) {
    if ((cur + s).length <= size) { cur += s; continue; }
    push();
    if (s.length <= size) { cur = s; continue; }
    for (const w of s.split(/\s+/)) {
      if (w.length > size) { push(); for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size)); continue; }
      if ((cur + ' ' + w).trim().length > size) push();
      cur = (cur + ' ' + w).trim();
    }
  }
  push();
  return out;
}
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const voiceName = () => store.voiceName || process.env.VOICE_NAME || 'Despina';
const geminiOn = () => Boolean(process.env.GEMINI_API_KEY) && (process.env.VOICE_PROVIDER || '').toLowerCase() !== 'google';
const findAudio = (n, d = 0) => {
  if (!n || typeof n !== 'object' || d > 8) return null;
  if (n.type === 'audio' && typeof n.data === 'string' && n.data.length > 100) return n.data;
  for (const v of Object.values(n)) { const f = findAudio(v, d + 1); if (f) return f; }
  return null;
};
async function geminiSpeak(text) {
  const res = await http('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', timeoutMs: 30000, headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.VOICE_MODEL || 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: process.env.VOICE_STYLE || 'calm, cool and relaxed, soft and unhurried, warm and natural, with a clean dry studio sound and no echo or reverb' }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voiceName() }] },
    }),
  });
  const b64 = findAudio(res);
  if (!b64) throw new Error('Gemini voice sent no audio');
  return Buffer.from(b64, 'base64');
}
async function synthesize(text, lang) {
  if (geminiOn()) { try { return await geminiSpeak(speakable(text)); } catch (e) { warn('Gemini voice failed, using the backup voice:', e.message); } }
  const parts = [];
  for (const chunk of chunkText(speakable(text))) {
    parts.push(await http(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(chunk)}`,
      { as: 'buffer', timeoutMs: 15000, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', referer: 'https://translate.google.com/' } }));
  }
  if (!parts.length) throw new Error('nothing to say');
  return Buffer.concat(parts);
}

// ---------- downloader (.dl) ----------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EXT_KIND = { mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', '3gp': 'video', mp3: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image' };
const extOf = (u) => { try { return new URL(u).pathname.split('.').pop().toLowerCase(); } catch (_) { return ''; } };

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private address');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('private address'); return; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (_) { return; }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}
async function getJson(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, body, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok && !(data && typeof data === 'object')) throw new Error(`HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function readLimited(res, max) {
  if (Number(res.headers.get('content-length') || 0) > max) throw new Error('too big');
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (_) {} throw new Error('too big'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
async function fetchFile(url) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    await assertPublic(cur);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(cur, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'manual', signal: ctrl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await readLimited(res, CONFIG.dlMaxBytes);
      return { buf, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), url: cur };
    } finally { clearTimeout(timer); }
  }
  throw new Error('too many redirects');
}
async function viaTikwm(url, wantAudio) {
  const r = await getJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  const d = r && r.data;
  if (!r || r.code !== 0 || !d) throw new Error((r && r.msg) || 'tikwm failed');
  const base = 'https://www.tikwm.com';
  const abs = (u) => new URL(u, base).toString();
  if (wantAudio) { if (!d.music) throw new Error('no audio'); return [{ url: abs(d.music), hint: 'audio', title: d.title }]; }
  if (Array.isArray(d.images) && d.images.length) return d.images.slice(0, 8).map((u, i) => ({ url: abs(u), hint: 'image', title: i === 0 ? d.title : '' }));
  const v = d.hdplay || d.play;
  if (!v) throw new Error('no video');
  return [{ url: abs(v), hint: 'video', title: d.title }];
}
async function viaCobalt(url, wantAudio) {
  if (!CONFIG.cobaltUrl) throw new Error('no cobalt');
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (CONFIG.cobaltKey) headers.authorization = `Api-Key ${CONFIG.cobaltKey}`;
  const r = await getJson(CONFIG.cobaltUrl.replace(/\/+$/, '') + '/', {
    method: 'POST', headers, timeoutMs: 45000,
    body: JSON.stringify({ url, downloadMode: wantAudio ? 'audio' : 'auto', videoQuality: '720', filenameStyle: 'basic' }),
  });
  if (!r) throw new Error('empty answer');
  if (r.status === 'error') throw new Error((r.error && r.error.code) || 'cobalt error');
  if ((r.status === 'tunnel' || r.status === 'redirect') && r.url) return [{ url: r.url, hint: wantAudio ? 'audio' : 'video', name: r.filename }];
  if (r.status === 'picker' && Array.isArray(r.picker)) return r.picker.slice(0, 8).map((p) => ({ url: p.url, hint: p.type === 'photo' ? 'image' : 'video' }));
  throw new Error('unexpected answer');
}
async function resolveLink(url, wantAudio) {
  const tried = [];
  if (/(^|\.)tiktok\.com$/i.test(new URL(url).hostname)) {
    try { return await viaTikwm(url, wantAudio); } catch (e) { tried.push(`tikwm: ${e.message}`); }
  }
  if (CONFIG.cobaltUrl) {
    try { return await viaCobalt(url, wantAudio); } catch (e) { tried.push(`cobalt: ${e.message}`); }
  }
  if (EXT_KIND[extOf(url)]) return [{ url, hint: EXT_KIND[extOf(url)] }];
  const err = new Error(tried.join(' | ') || 'no downloader');
  err.noService = !CONFIG.cobaltUrl && !/tiktok\.com/i.test(url);
  throw err;
}
async function sendFile(ctx, f, caption) {
  const file = await fetchFile(f.url);
  if (file.type === 'text/html') throw new Error('that link is a web page, not a file');
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : EXT_KIND[extOf(file.url)] || f.hint || 'document';
  const q = { quoted: ctx.msg };
  const cap = caption ? String(caption).slice(0, 300) : undefined;
  if (kind === 'video') return ctx.sock.sendMessage(ctx.jid, { video: file.buf, mimetype: 'video/mp4', caption: cap }, q);
  if (kind === 'audio') return ctx.sock.sendMessage(ctx.jid, { audio: file.buf, mimetype: file.type.startsWith('audio/') ? file.type : 'audio/mpeg', ptt: false }, q);
  if (kind === 'image') return ctx.sock.sendMessage(ctx.jid, { image: file.buf, caption: cap }, q);
  const name = f.name || decodeURIComponent(new URL(file.url).pathname.split('/').pop() || 'file');
  return ctx.sock.sendMessage(ctx.jid, { document: file.buf, mimetype: file.type || 'application/octet-stream', fileName: name }, q);
}
async function download(ctx) {
  const quoted = ctx.ctxInfo?.quotedMessage ? getText(unwrap(ctx.ctxInfo.quotedMessage)) : '';
  const urlRe = /https?:\/\/[^\s<>"']+/i;
  const url = (urlRe.exec(ctx.argText) || urlRe.exec(quoted) || [])[0];
  if (!url) return ctx.reply(`Give me a link, or reply to one.\nExample: ${S.prefix()}dl https://vm.tiktok.com/xxxx\nAdd "audio" to get just the sound.`);
  const wantAudio = /\b(?:audio|mp3)\b/i.test(ctx.argText.replace(url, ''));
  await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
  let files;
  try { files = await resolveLink(url, wantAudio); } catch (e) {
    warn('dl could not resolve a link:', e.message);
    if (e.noService) return ctx.reply("I can't download from that site yet. The server needs a downloader set up (COBALT_API_URL). TikTok and direct file links work without it.");
    return ctx.reply("Couldn't get that one. The link may be private, or the downloader is down.");
  }
  let sentAny = false;
  for (const f of files) {
    try { await sendFile(ctx, f, f.title); sentAny = true; } catch (e) {
      warn('dl send failed:', e.message);
      if (e.message === 'too big') return ctx.reply(`That file is over ${Math.round(CONFIG.dlMaxBytes / 1048576)} MB. Too big to send.`);
      if (!sentAny && files.length === 1) return ctx.reply(/web page/.test(e.message) ? "That's a web page, not a file." : 'Found it, but the download failed. Try again in a bit.');
    }
  }
  if (!sentAny) return ctx.reply('Found it, but none of the files would download.');
}

// ---------- auto-read (blue ticks like a person) ----------
// Called for every incoming message by handleCommand: reads after a human pause (0.8-6 s), a whole run of messages at once.
// Skips status, channels, her own messages and chats where she is asleep. .autoread on|off|dm|groups (owner).
const arSpeed = () => { const n = parseFloat(process.env.AUTOREAD_SPEED); return Number.isFinite(n) && n >= 0 ? n : 1; };
const arQueues = new Map();
function arWants(jid, mode) {
  if (mode === 'off') return false;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false;
  const group = jid.endsWith('@g.us');
  return mode === 'on' || (mode === 'groups' ? group : !group);
}
function autoreadSchedule(sock, msg, textLength = 0) {
  const jid = msg.key.remoteJid;
  if (msg.key.fromMe || !arWants(jid, store.autoread)) return false;
  let q = arQueues.get(jid);
  if (!q) { q = { keys: [], timer: null }; arQueues.set(jid, q); }
  q.keys.push(msg.key); if (q.keys.length > 50) q.keys.shift();
  clearTimeout(q.timer);
  const wait = humanOn() ? Math.round((800 + Math.min(textLength, 250) * 8 + humanRand(0, 1800)) * arSpeed()) : 0;
  q.timer = setTimeout(async () => {
    arQueues.delete(jid);
    if (S.isAsleep(jid) || !arWants(jid, store.autoread)) return;
    try { await sock.readMessages(q.keys); } catch (_) { /* not critical */ }
  }, wait);
  if (q.timer.unref) q.timer.unref();
  return true;
}
const autoreadCommands = [
  {
    name: 'autoread', aliases: ['seen'], category: 'OWNER', menu: ['autoread on', 'autoread off'], ownerOnly: true,
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (!['on', 'off', 'dm', 'groups'].includes(a)) {
        const now = store.autoread;
        return ctx.reply(`Auto-read is ${now === 'on' ? 'on (all chats)' : now === 'dm' ? 'on for private chats only' : now === 'groups' ? 'on for groups only' : 'off'}.\nUse ${S.prefix()}autoread on, off, dm or groups.`);
      }
      store.autoread = a; save();
      return ctx.reply({ on: "Okay. I'll read messages like a person: a little after they arrive.", off: "Done. I'll stop reading messages on my own.", dm: "Okay. I'll auto-read private chats only.", groups: "Okay. I'll auto-read groups only." }[a]);
    },
  },
];

// ---------- SOCIAL & PROFILE: marry, marryaccept, marrydecline, divorce, age/setage, bio/setbio, namechange/changename, profile ----------
// Fun in-bot stuff only (nothing touches anyone's real WhatsApp profile). Marriage is 18+ and both people must have set their age.
const SOC_PROPOSAL_MS = 5 * 60 * 1000;
const SOC_NAME_COOLDOWN_MS = 60 * 60 * 1000;
const socJid = (n) => `${n}@s.whatsapp.net`;
const socUser = (n) => (store.social.users[n] ||= {});
const socAgo = (ms) => { const m = Math.floor(ms / 60000); if (m < 60) return `${Math.max(1, m)}m`; const h = Math.floor(m / 60); return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`; };

// The name Lumi uses for someone: their chosen name, else their WhatsApp name.
const socialName = (num, fallback = '') => (store.social.users[num] && store.social.users[num].name) || fallback;

// Who is being targeted: a real @socTag or the person replied to.
function socTarget(ctx) {
  const tags = (ctx.taggedJids && ctx.taggedJids.length ? ctx.taggedJids : []).filter(Boolean);
  const j = tags[0] || ctx.ctxInfo?.participant;
  return j ? { jid: j, num: numberOf(j) } : null;
}
const socIsBot = (ctx, num) => [ctx.sock.user?.id, ctx.sock.user?.lid].filter(Boolean).map(numberOf).includes(num);
const socMarried = (n) => Boolean(store.social.users[n] && store.social.users[n].spouse);
const socPending = (toNum) => {
  const p = store.social.proposals[toNum];
  if (p && Date.now() - p.at > SOC_PROPOSAL_MS) { delete store.social.proposals[toNum]; return null; }
  return p || null;
};
const socTag = (num, jid) => ({ text: `@${num}`, jid: jid || socJid(num) });
const socAdult = (n) => (store.social.users[n] && store.social.users[n].age) >= 18;
const socNeed = (ctx) => `${S.prefix()}setage 20`;

async function socSay(ctx, text, jids = []) {
  return ctx.sock.sendMessage(ctx.jid, { text, mentions: jids }, { quoted: ctx.msg });
}

const socialCommands = [
  {
    name: 'marry', aliases: ['propose'], category: 'SOCIAL & PROFILE', menu: ['marry @socUser'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Proposals go in a group, so everybody can witness it.');
      const t = socTarget(ctx);
      if (!t) return ctx.reply(`Tag who you're shooting your shot at, or reply to their message.\nExample: ${S.prefix()}marry @crush`);
      const me = ctx.senderNum;
      if (t.num === me) return ctx.reply('Marry yourself? Self-love is lit, but nah. Tag someone else.');
      if (socIsBot(ctx, t.num)) return ctx.reply("Me? I'm flattered, but I'm married to the grind. Pick a human.");
      if (!socAdult(me)) return ctx.reply(`Marriage is 18+ only. Set your real age first: ${socNeed(ctx)}`);
      if (!socAdult(t.num)) return ctx.reply("They haven't set an age (18+) yet. Tell them to run .setage first, then shoot again.");
      if (socMarried(me)) return ctx.reply(`You're already married to @${socUser(me).spouse}. Run ${S.prefix()}divorce first. No double-dipping.`);
      if (socMarried(t.num)) return ctx.reply('Eyyy, they are already taken. Respect the ring.');
      if (socPending(t.num)) return ctx.reply('Someone already shot their shot at them. Let that one finish first.');
      for (const [to, p] of Object.entries(store.social.proposals)) if (p.from === me && Date.now() - p.at <= SOC_PROPOSAL_MS) return ctx.reply(`You still have a proposal waiting on @${to}. Be patient, king/queen.`);
      store.social.proposals[t.num] = { from: me, fromJid: ctx.sender, toJid: t.jid, at: Date.now() };
      save();
      socUser(me).jid = ctx.sender; socUser(t.num).jid = t.jid; save();
      return socSay(ctx, `💍 *PROPOSAL ALERT* 💍\n\n@${me} just got on one knee for @${t.num}!\n\n@${t.num}, you've got 5 minutes:\n✅ ${S.prefix()}marryaccept\n❌ ${S.prefix()}marrydecline\n\nEverybody is watching. No pressure 👀`, [ctx.sender, t.jid]);
    },
  },
  {
    name: 'marryaccept', aliases: ['accept', 'iwill'], category: 'SOCIAL & PROFILE', menu: ['marryaccept'],
    run: async (ctx) => {
      const me = ctx.senderNum; const p = socPending(me);
      if (!p) return ctx.reply("Nobody has proposed to you (or it expired). Relax, your time is coming.");
      if (socMarried(p.from) || socMarried(me)) { delete store.social.proposals[me]; save(); return ctx.reply('Too late: one of you is already taken now.'); }
      delete store.social.proposals[me];
      const at = Date.now();
      socUser(me).spouse = p.from; socUser(me).since = at; socUser(me).jid = ctx.sender;
      socUser(p.from).spouse = me; socUser(p.from).since = at; socUser(p.from).jid = p.fromJid;
      save();
      return socSay(ctx, `🎉💒 *THEY SAID YES!* 💒🎉\n\n@${p.from} and @${me} are now married!\nDrinks are on the group tonight 🥂🔥\n\nCongrats lovebirds. Don't make me come and settle quarrels.`, [p.fromJid, ctx.sender]);
    },
  },
  {
    name: 'marrydecline', aliases: ['decline', 'reject', 'idontwill'], category: 'SOCIAL & PROFILE', menu: ['marrydecline'],
    run: async (ctx) => {
      const me = ctx.senderNum; const p = socPending(me);
      if (!p) return ctx.reply('Nobody is waiting on an answer from you.');
      delete store.social.proposals[me]; save();
      return socSay(ctx, `💀 *REJECTED* 💀\n\n@${me} looked at @${p.from} and said "nah, not today".\n@${p.from}, hold your head up. We move. 🫡`, [ctx.sender, p.fromJid]);
    },
  },
  {
    name: 'divorce', aliases: ['breakup'], category: 'SOCIAL & PROFILE', menu: ['divorce'],
    run: async (ctx) => {
      const me = ctx.senderNum; const u = socUser(me);
      if (!u.spouse) return ctx.reply("You're not even married. Who are you divorcing, your shadow?");
      const ex = u.spouse; const days = socAgo(Date.now() - (u.since || Date.now())); const exJid = (store.social.users[ex] && store.social.users[ex].jid) || socJid(ex);
      delete u.spouse; delete u.since;
      if (store.social.users[ex]) { delete store.social.users[ex].spouse; delete store.social.users[ex].since; }
      save();
      return socSay(ctx, `💔 *IT'S OVER* 💔\n\n@${me} and @${ex} are done after ${days}.\nBoth of you are single again. Nobody go cry for me o. 😭`, [ctx.sender, exJid]);
    },
  },
  {
    name: 'age', category: 'SOCIAL & PROFILE', menu: ['age', 'setage <number>'],
    run: async (ctx) => {
      const t = socTarget(ctx); const num = t ? t.num : ctx.senderNum; const u = store.social.users[num];
      if (!u || !u.age) return ctx.reply(num === ctx.senderNum ? `You haven't set your age. ${S.prefix()}setage 20` : "They haven't set an age yet.");
      return ctx.reply(num === ctx.senderNum ? `You are ${u.age}.` : `They are ${u.age}.`);
    },
  },
  {
    name: 'setage', category: 'SOCIAL & PROFILE', menu: [],
    run: async (ctx) => {
      const n = parseInt(ctx.args[0], 10);
      if (!Number.isInteger(n) || String(n) !== String(ctx.args[0]).trim()) return ctx.reply(`Give me a number. Example: ${S.prefix()}setage 20`);
      if (n < 13) return ctx.reply('WhatsApp is 13+, so I socNeed a real age of 13 or more.');
      if (n > 99) return ctx.reply("Come on. Put your real age.");
      const u = socUser(ctx.senderNum); u.age = n; u.jid = ctx.sender; save();
      return ctx.reply(`Age saved: ${n}. ${n >= 18 ? 'You can shoot your shot now 💍' : "Marriage opens at 18, but the rest of my commands are yours."}`);
    },
  },
  {
    name: 'bio', category: 'SOCIAL & PROFILE', menu: ['bio', 'setbio <text>'],
    run: async (ctx) => {
      const t = socTarget(ctx); const num = t ? t.num : ctx.senderNum; const u = store.social.users[num];
      if (!u || !u.bio) return ctx.reply(num === ctx.senderNum ? `You have no bio yet. ${S.prefix()}setbio your words here` : 'They have no bio yet.');
      return ctx.reply(`📝 ${num === ctx.senderNum ? 'Your bio' : 'Their bio'}:\n${u.bio}`);
    },
  },
  {
    name: 'setbio', category: 'SOCIAL & PROFILE', menu: [],
    run: async (ctx) => {
      const text = ctx.argText.replace(/\s+/g, ' ').trim();
      if (!text) return ctx.reply(`Write your bio after the command.\nExample: ${S.prefix()}setbio Chilling. Eating. Repeating.\nClear it with ${S.prefix()}setbio clear`);
      const u = socUser(ctx.senderNum);
      if (/^(clear|remove|reset)$/i.test(text)) { delete u.bio; save(); return ctx.reply('Bio cleared. Clean slate.'); }
      if (text.length > 150) return ctx.reply('Keep it under 150 characters, we are not writing a novel.');
      if (/https?:\/\/|www\.|\b\S+\.(?:com|net|org|xyz|ng|io)\b/i.test(text)) return ctx.reply('No links in bios.');
      u.bio = text; u.jid = ctx.sender; save();
      return ctx.reply('Bio saved. Looking good. 😎');
    },
  },
  {
    name: 'namechange', aliases: ['changename', 'nick'], category: 'SOCIAL & PROFILE', menu: ['namechange <name>'],
    run: async (ctx) => {
      const name = ctx.argText.replace(/\s+/g, ' ').trim();
      const u = socUser(ctx.senderNum);
      if (!name) return ctx.reply(`What should I call you?\nExample: ${S.prefix()}namechange Big Chris\n${u.name ? `Right now it's "${u.name}".` : ''}`.trim());
      if (/^(clear|reset|default)$/i.test(name)) { delete u.name; save(); return ctx.reply('Back to your WhatsApp name.'); }
      if (name.length < 2 || name.length > 20) return ctx.reply('Between 2 and 20 characters, please.');
      if (/[@<>]|https?:|www\.|\.\w{2,}\b/i.test(name)) return ctx.reply('No @, links or weird stuff in names.');
      const low = name.toLowerCase();
      if (low.includes('lumi') || low === String(CONFIG.ownerName || '').toLowerCase()) return ctx.reply("You can't be me or my owner. Pick your own name.");
      const left = (u.nameAt || 0) + SOC_NAME_COOLDOWN_MS - Date.now();
      if (!ctx.isOwner && left > 0) return ctx.reply(`Slow down, you changed it recently. Try again in ${Math.ceil(left / 60000)} min.`);
      u.name = name; u.nameAt = Date.now(); u.jid = ctx.sender; save();
      return ctx.reply(`Done. From now on I'll call you *${name}* 🔥`);
    },
  },
  {
    name: 'profile', aliases: ['me', 'whois'], category: 'SOCIAL & PROFILE', menu: ['profile'],
    run: async (ctx) => {
      const t = socTarget(ctx); const num = t ? t.num : ctx.senderNum; const u = store.social.users[num] || {};
      const name = u.name || (num === ctx.senderNum ? ctx.pushName : '') || `@${num}`;
      const lines = [`👤 *${name}*`, `🎂 Age: ${u.age || 'not set'}`, `📝 Bio: ${u.bio || 'not set'}`,
        `💞 Status: ${u.spouse ? `married to @${u.spouse} (${socAgo(Date.now() - (u.since || Date.now()))})` : 'single'}`];
      const mentions = [t ? t.jid : ctx.sender].concat(u.spouse ? [(store.social.users[u.spouse] || {}).jid || socJid(u.spouse)] : []);
      return socSay(ctx, lines.join('\n').replace(`@${num}`, `@${num}`), mentions);
    },
  },
];

// ---------- sight (.read) and picture generation (.imagine) ----------
// .read: describe / read a picture or sticker (Gemini, then Groq vision). .imagine <text>: Gemini image model, then Pollinations (free).
// Needs GEMINI_API_KEY and/or GROQ_API_KEY in the environment. Host chat code can call lumi.imagineIntent(text) / lumi.lookAtPicture(...).
const VIS_MAX_BYTES = 5 * 1024 * 1024;
const visGeminiModel = () => process.env.VISION_MODEL || (process.env.GEMINI_MODEL || 'gemini-2.5-flash');
const visGroqModel = () => process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const visionEnabled = () => Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);

// Look at a picture. -> { text, provider } or null.
async function lookAtPicture(buf, mime, { system = '', prompt = 'Describe this picture.', maxTokens = 400 } = {}) {
  const type = /^image\//.test(mime || '') ? mime : 'image/jpeg';
  const b64 = buf.toString('base64');
  if (process.env.GEMINI_API_KEY) {
    try {
      const data = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(visGeminiModel())}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: type, data: b64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
        }),
        timeoutMs: 30000,
      });
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (text) return { text, provider: 'Gemini' };
    } catch (e) { warn('Gemini vision failed:', e.message); }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const data = await http('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: visGroqModel(), temperature: 0.7, max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } }] },
          ],
        }),
        timeoutMs: 30000,
      });
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (text) return { text, provider: 'Groq' };
    } catch (e) { warn('Groq vision failed:', e.message); }
  }
  return null;
}

// Picture or sticker in the message itself, or in the one it replies to. -> { buf, mime, kind } | { error }
async function fetchPicture(ctx) {
  const media = findMedia(ctx.msg, ['image', 'sticker']);
  if (!media) return { error: 'none' };
  if ((Number(media.node.fileLength) || 0) > VIS_MAX_BYTES) return { error: 'big' };
  try {
    const buf = await downloadMedia(ctx.sock, media.source);
    if (!buf || !buf.length || buf.length > VIS_MAX_BYTES) return { error: 'big' };
    return { buf, mime: media.node.mimetype || (media.kind === 'sticker' ? 'image/webp' : 'image/jpeg'), kind: media.kind, caption: media.node.caption || '' };
  } catch (_) { return { error: 'download' }; }
}

const imgCooldownMs = () => { const n = parseInt(process.env.IMAGE_COOLDOWN_MS, 10); return Number.isFinite(n) ? n : 20000; };
const imgLastAt = new Map(); const imgBusy = new Set();
const IMG_MAX_PROMPT = 400;

// Not drawing sexual content, nudity, or anything involving minors in that way.
const IMG_BLOCKED = /\b(nsfw|porn\w*|nude|nudes|naked|hentai|erotic|sexual|sex|topless|lingerie|boobs?|genitals?|loli\w*|shota)\b/i;

// "draw ...", "imagine ...", "generateImage a picture of ..." -> the prompt, else null. (Called only when she is addressed.)
function imagineIntent(text) {
  const t = String(text || '').trim().replace(/^(?:hey\s+)?lumi[\s,:;-]+/i, '').replace(/^(?:please|pls|can you|could you|will you)\s+/i, '');
  let m = /^(?:draw|paint|sketch|imagine)\s+(?:me\s+)?(.{3,})$/is.exec(t);
  if (!m) m = /^(?:generateImage|create|make|design|show me)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:image|picture|pic|photo|illustration|drawing|artwork|wallpaper|logo|portrait)\s*(?:of|for|showing|with|about)?\s*(.{3,})$/is.exec(t);
  return m ? m[1].trim().replace(/[.!?]+$/, '') : null;
}

const isImageBuf = (b) => Buffer.isBuffer(b) && b.length > 1000 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b.slice(0, 4).toString() === 'RIFF'));

async function imgViaGemini(prompt) {
  const data = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.IMAGE_MODEL || 'gemini-2.5-flash-image')}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
    timeoutMs: 60000,
  });
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => (p.inlineData || p.inline_data || {}).data);
  if (!part) throw new Error('no image in answer');
  const buf = Buffer.from((part.inlineData || part.inline_data).data, 'base64');
  if (!isImageBuf(buf)) throw new Error('not an image');
  return buf;
}
async function imgViaPollinations(prompt) {
  const seed = Math.floor(Math.random() * 1e6);
  const buf = await http(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`, { as: 'buffer', timeoutMs: 90000 });
  if (!isImageBuf(buf)) throw new Error('not an image');
  return buf;
}

// -> { buf, provider } or throws
async function generateImage(prompt) {
  const which = (process.env.IMAGE_PROVIDER || 'auto').toLowerCase();
  const tried = [];
  if (which !== 'pollinations' && process.env.GEMINI_API_KEY) {
    try { return { buf: await imgViaGemini(prompt), provider: 'Gemini' }; } catch (e) { tried.push(`gemini: ${e.message}`); warn('Gemini image failed:', e.message); }
  }
  if (which !== 'gemini') {
    try { return { buf: await imgViaPollinations(prompt), provider: 'Pollinations' }; } catch (e) { tried.push(`pollinations: ${e.message}`); warn('Pollinations failed:', e.message); }
  }
  throw new Error(tried.join(' | ') || 'no image service');
}

// Shared by .imagine and the natural-language "draw ..." path.
async function imagineHandle(ctx, rawPrompt) {
  const prompt = String(rawPrompt || '').trim();
  if (!prompt) return ctx.reply(`Tell me what to draw.\nExample: ${S.prefix()}imagine a lion wearing a crown`);
  if (prompt.length > IMG_MAX_PROMPT) return ctx.reply(`Keep it under ${IMG_MAX_PROMPT} characters.`);
  if (IMG_BLOCKED.test(prompt)) return ctx.reply("Not drawing that. Ask me for something else.");
  if (imgBusy.has(ctx.jid)) return ctx.reply('Still painting the last one. Hold on.');
  if (!ctx.isOwner && Date.now() - (imgLastAt.get(ctx.senderNum) || 0) < imgCooldownMs()) return ctx.reply('Give me a moment between pictures.');
  imgLastAt.set(ctx.senderNum, Date.now()); imgBusy.add(ctx.jid);
  try {
    await ctx.sock.sendMessage(ctx.jid, { react: { text: '🎨', key: ctx.msg.key } }).catch(() => {});
    await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
    let out;
    try { out = await generateImage(prompt); } catch (e) { imgLastAt.delete(ctx.senderNum); return ctx.reply("I couldn't paint that right now. Try again in a bit."); }
    await ctx.sock.sendMessage(ctx.jid, { image: out.buf, caption: prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt }, { quoted: ctx.msg });
  } finally { imgBusy.delete(ctx.jid); await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {}); }
}

const visionCommands = [
  {
    name: 'read', aliases: ['see', 'ocr', 'whatsthis'], category: 'AI SYSTEM', menu: ['read'],
    run: async (ctx) => {
      if (!visionEnabled()) return ctx.reply("I can't see pictures right now: no Gemini or Groq key is set.");
      const pic = await fetchPicture(ctx);
      if (pic.error === 'none') return ctx.reply(`Reply to a picture or sticker with ${S.prefix()}read, or send one with ${S.prefix()}read as the caption.\nYou can ask something too: ${S.prefix()}read what does it say?`);
      if (pic.error === 'big') return ctx.reply('That picture is too big for me (5 MB max).');
      if (pic.error) return ctx.reply("I couldn't download that one.");
      const question = ctx.argText.trim();
      await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
      const res = await lookAtPicture(pic.buf, pic.mime, {
        system: 'You are Lumi, a calm, clear WhatsApp assistant. Reply in plain text, no markdown headings, short.',
        prompt: question || (pic.kind === 'sticker'
          ? 'This is a WhatsApp sticker. Say what it shows and what feeling or message it expresses. Read out any text on it exactly.'
          : 'Describe this picture briefly. If it contains text, read it out exactly.'),
        maxTokens: 500,
      });
      await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
      if (!res) return ctx.reply("I couldn't make sense of that one. Try again in a bit.");
      return ctx.reply(res.text);
    },
  },
];
const imagineCommands = [
  {
    name: 'imagine', aliases: ['img', 'draw', 'gen', 'generateImage', 'createimage'], category: 'AI SYSTEM', menu: ['imagine <description>'],
    run: (ctx) => imagineHandle(ctx, ctx.argText),
  },
];

// ---------- view-once reveal (owner) + vault ----------
// Lumi keeps a memory-only copy of view-once messages for 6 hours (nothing is written to disk), so .vv still
// works after they are opened. VAULT_ALL=true also keeps ordinary messages (no media). Max 600 entries.
const VO_KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document' };
const VAULT_TTL = 6 * 3600 * 1000, VAULT_MAX = 600, VAULT_MAX_MEDIA = 12 * 1024 * 1024;
const vault = new Map(); // "jid|id" -> { at, raw, viewOnce, mediaBuffer }
const vaultKeepAll = () => /^(1|true|yes|on)$/i.test(process.env.VAULT_ALL || '');
function vaultPrune() {
  for (const [k, r] of vault) if (Date.now() - r.at > VAULT_TTL) vault.delete(k);
  while (vault.size > VAULT_MAX) vault.delete(vault.keys().next().value);
}
function isViewOnceMsg(message) {
  let c = message || {};
  for (let i = 0; i < 8; i++) {
    if (c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension) return true;
    const n = c.ephemeralMessage?.message || c.documentWithCaptionMessage?.message;
    if (!n) break;
    c = n;
  }
  return Object.keys(VO_KINDS).some((k) => c[k] && c[k].viewOnce === true);
}
// Remember a message (view-once only by default) and grab its media while WhatsApp still serves it.
async function vaultRemember(sock, msg) {
  try {
    if (!msg.message || msg.message.protocolMessage) return;
    const vo = isViewOnceMsg(msg.message);
    if (!vo && !vaultKeepAll()) return;
    const rec = { at: Date.now(), raw: msg, viewOnce: vo, mediaBuffer: null };
    vault.set(`${msg.key.remoteJid}|${msg.key.id}`, rec);
    vaultPrune();
    if (!vo) return;
    let c = msg.message;
    for (let i = 0; i < 6; i++) { const n = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message || c.documentWithCaptionMessage?.message; if (!n) break; c = n; }
    const key = Object.keys(VO_KINDS).find((k) => c[k]);
    if (!key || Number(c[key].fileLength || 0) > VAULT_MAX_MEDIA) return;
    let buf;
    try { buf = await downloadMedia(sock, { key: msg.key, message: msg.message }); }
    catch (_) { const st = await downloadContentFromMessage(c[key], VO_KINDS[key]); const ch = []; for await (const x of st) ch.push(x); buf = Buffer.concat(ch); }
    if (buf && buf.length >= 100 && buf.length <= VAULT_MAX_MEDIA) rec.mediaBuffer = buf;
  } catch (e) { warn('vault: could not save media:', e.message); }
}
const vaultLookup = (jid, id) => { const r = vault.get(`${jid}|${id}`); return r && Date.now() - r.at <= VAULT_TTL ? r : null; };

function findViewOnce(quoted) {
  let m = quoted, wrappedVo = false;
  for (let i = 0; i < 6 && m; i++) {
    const vo = m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension;
    if (vo) { wrappedVo = true; m = vo.message; continue; }
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  if (!m) return null;
  for (const key of Object.keys(VO_KINDS)) {
    const node = m[key];
    if (node && (wrappedVo || node.viewOnce === true)) return { key, type: VO_KINDS[key], node };
  }
  return null;
}
function contextInfoDeep(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (node.contextInfo) return node.contextInfo;
  for (const v of Object.values(node)) {
    if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) continue;
    const f = contextInfoDeep(v, depth + 1);
    if (f) return f;
  }
  return null;
}
async function voToBuffer(node, type) {
  const stream = await downloadContentFromMessage(node, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
async function revealViewOnce(ctx, toDm) {
  try {
    const context = ctx.ctxInfo?.quotedMessage ? ctx.ctxInfo : contextInfoDeep(ctx.msg?.message);
    const quoted = context?.quotedMessage;
    if (!quoted) return await ctx.reply('Reply to a view-once message');
    const saved = context.stanzaId ? vaultLookup(ctx.jid, context.stanzaId) : null; // copy saved on arrival
    let found = findViewOnce(quoted) || (saved && findViewOnce(saved.raw.message));
    if (!found) return await ctx.reply('Reply to a view-once message');
    let buffer = saved && saved.mediaBuffer;
    if (!buffer) {
      try { buffer = await voToBuffer(found.node, found.type); }
      catch (e) {
        const raw = saved && findViewOnce(saved.raw.message);
        if (!raw) throw e;
        buffer = await voToBuffer(raw.node, raw.type);
      }
    }
    if (!buffer || !buffer.length) throw new Error('empty download');
    const { key, node } = found;
    const content = key === 'imageMessage' ? { image: buffer, caption: node.caption || '' }
      : key === 'videoMessage' ? { video: buffer, caption: node.caption || '', mimetype: node.mimetype || 'video/mp4' }
      : key === 'documentMessage' ? { document: buffer, mimetype: node.mimetype || 'application/octet-stream', fileName: node.fileName || 'revealed-file' }
      : { audio: buffer, mimetype: node.mimetype || 'audio/ogg; codecs=opus', ptt: node.ptt === true };
    if (toDm) {
      const k = ctx.msg.key;
      const dm = ctx.isGroup ? ([k.participantPn, k.participantAlt, ctx.sender].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender) : ctx.jid;
      await ctx.sock.sendMessage(dm, content);
      if (dm !== ctx.jid) await ctx.sock.sendMessage(ctx.jid, { react: { text: '✅', key: ctx.msg.key } }).catch(() => {});
    } else await ctx.sock.sendMessage(ctx.jid, content, { quoted: ctx.msg });
  } catch (e) {
    warn('vv failed:', e.message);
    const gone = /404|410|not found|expired|directpath|url|empty/i.test(e.message);
    await ctx.reply(gone ? "I couldn't get it. WhatsApp no longer serves that file and I didn't catch it when it arrived." : "Couldn't reveal that one.").catch(() => {});
  }
}

// ---------- games ----------

const IDLE = 10 * 60 * 1000;
const live = (map, id, idle = IDLE) => {
  const g = map.get(id);
  if (g && Date.now() - g.at > idle) { map.delete(id); return null; }
  return g || null;
};
const win = (ctx) => addWin(ctx.senderNum, ctx.pushName);
const P = () => S.prefix();

const RPS = { rock: '🪨', paper: '📄', scissors: '✂️' };
const RPS_ALIAS = { r: 'rock', rock: 'rock', p: 'paper', paper: 'paper', s: 'scissors', scissor: 'scissors', scissors: 'scissors' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const BALL = ['Yes.', 'No.', 'Obviously.', "Don't count on it.", 'Ask me when I care.', 'Probably.', 'Doubt it.', 'Without a doubt.', 'Not a chance.', 'Maybe. Maybe not.', 'The signs say yes.', "I wouldn't."];
const REEL = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣'];

const guessGames = new Map(), GUESS_MAX = 10;
const mathGames = new Map();
function mathQuestion() {
  const t = rnd(3), a = 2 + rnd(40), b = 2 + rnd(40);
  if (t === 0) return { q: `${a} + ${b}`, a: a + b };
  if (t === 1) { const [x, y] = a >= b ? [a, b] : [b, a]; return { q: `${x} - ${y}`, a: x - y }; }
  const m = 2 + rnd(11), n = 2 + rnd(11);
  return { q: `${m} × ${n}`, a: m * n };
}

const tttGames = new Map();
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const cell = (b, i) => (b[i] === 'x' ? '❌' : b[i] === 'o' ? '⭕' : NUM[i]);
const renderBoard = (b) => [0, 3, 6].map((r) => `${cell(b, r)}${cell(b, r + 1)}${cell(b, r + 2)}`).join('\n');
const winnerOf = (b) => { for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return null; };
const tttSend = (ctx, g, head) => ctx.reply(`${head}\n\n${renderBoard(g.board)}`, { mentions: [g.xJid, g.oJid] });

const hangGames = new Map();
const WORDS = ['whatsapp', 'keyboard', 'sunrise', 'journey', 'thunder', 'pyramid', 'puzzle', 'monster', 'library', 'diamond', 'shadow', 'rainbow', 'volcano', 'compass', 'lantern', 'blanket', 'penguin', 'dragon', 'galaxy', 'mystery', 'pocket', 'jungle', 'picnic', 'harvest', 'warrior', 'whisper', 'crystal', 'silence', 'garden', 'bridge'];
const HANG_MAX = 6;
const hangView = (g) => `${[...g.word].map((c) => (g.guessed.has(c) ? c : '_')).join(' ')}\nLives: ${'❤️'.repeat(HANG_MAX - g.wrong)}${'🖤'.repeat(g.wrong)}` + (g.wrongLetters.length ? `\nWrong: ${g.wrongLetters.join(' ')}` : '');

// ---------- the commands ----------
// Each: { name, aliases, category, menu: [...shown in menu], hidden, ownerOnly, mainOwnerOnly, run(ctx) }

const sendMenu = (ctx) => ctx.reply(buildMenu());

// ---------- poll / jail / group picture / saved stickers ----------
const idsOfPart = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf);
const targetsOf = (ctx) => uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
const POLL_COOLDOWN_MS = 15000;
const pollAt = new Map();
function parsePoll(raw) {
  let text = String(raw || '');
  const multi = /(?:^|\s)--multi\b/i.test(text);
  text = text.replace(/(?:^|\s)--multi\b/ig, ' ').trim();
  const [name, ...values] = text.split(/\s*[|\n]\s*/).map((x) => x.trim()).filter(Boolean);
  return { name, values: [...new Set(values)], multi };
}
const MAX_JAILED_PER_GROUP = 20;
function parseJailTime(a) {
  const m = /^(\d+)\s*(m|min|h|hr|d|day|days)$/i.exec(String(a || '').trim());
  if (!m) return null;
  const u = m[2].toLowerCase();
  const ms = parseInt(m[1], 10) * (u.startsWith('d') ? 86400000 : u.startsWith('h') ? 3600000 : 60000);
  return ms >= 60000 && ms <= 7 * 86400000 ? ms : null;
}
const fmtJail = (ms) => { const m = Math.ceil(ms / 60000); return m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`; };
function jailRecord(jid, ids) {
  const g = store.jail[jid];
  if (!g) return null;
  for (const [key, rec] of Object.entries(g)) {
    if (rec.until && rec.until <= Date.now()) { delete g[key]; save(); continue; }
    if (rec.ids.some((n) => ids.includes(n))) return rec;
  }
  return null;
}
// Jailed person's message in a group: delete it. Returns true if handled.
async function jailCheck(ctx) {
  if (!ctx.isGroup || !store.jail[ctx.jid] || S.isOwner(ctx.senderNum)) return false;
  const k = ctx.msg.key;
  const ids = uniq([k.participant, k.participantAlt, k.participantPn].filter(Boolean).map(numberOf));
  if (!jailRecord(ctx.jid, ids)) return false;
  try { await ctx.sock.sendMessage(ctx.jid, { delete: k }); } catch (e) { warn('jail delete failed:', e.message); }
  return true;
}
const STICKER_DIR = path.join(CONFIG.dataDir, 'stickers');
const STICKER_MAX_BYTES = 1024 * 1024, STICKER_MAX_TOTAL = 200, STICKER_MAX_PER_USER = 30;
const stickerName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
const stickerFile = (n) => path.join(STICKER_DIR, `${n}.webp`);

const funCommands = [
  {
    // .poll Best food? | Rice | Beans | Yam   (2-12 options, --multi = several answers)
    name: 'poll', aliases: ['createpoll'], category: 'GROUP TOOLS', menu: ['poll <question> | <option> | <option>'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Polls are for groups.');
      const { name, values, multi } = parsePoll(ctx.argText);
      if (!name || values.length < 2) return ctx.reply(`Give me a question and at least 2 options, split with |\nExample: ${S.prefix()}poll Best food? | Rice | Beans | Yam\nAdd --multi to let people pick several.`);
      if (values.length > 12) return ctx.reply('12 options at most.');
      if (name.length > 200 || values.some((v) => v.length > 100)) return ctx.reply('Keep the question under 200 characters and each option under 100.');
      if (!ctx.isOwner && Date.now() - (pollAt.get(ctx.jid) || 0) < POLL_COOLDOWN_MS) return ctx.reply('One poll at a time. Give it a few seconds.');
      pollAt.set(ctx.jid, Date.now());
      return ctx.sock.sendMessage(ctx.jid, { poll: { name, values, selectableCount: multi ? 0 : 1 } });
    },
  },
  {
    // .gcpp = this group's picture. Owner in a private chat: .gcpp <group name>
    name: 'gcpp', aliases: ['gcpic', 'groupicon', 'gcicon', 'getgcpp'], category: 'GROUP TOOLS', menu: ['gcpp'],
    run: async (ctx) => {
      let target = ctx.isGroup ? ctx.jid : null; let title = '';
      if (!target) {
        if (!ctx.isOwner) return ctx.reply('Use this inside the group.');
        const q = ctx.argText.trim().toLowerCase();
        if (!q) return ctx.reply(`Use it in the group, or tell me which one: ${S.prefix()}gcpp <group name>`);
        const hits = Object.values(await ctx.sock.groupFetchAllParticipating()).filter((g) => String(g.subject || '').toLowerCase().includes(q));
        if (!hits.length) return ctx.reply("I'm not in a group with that name.");
        if (hits.length > 1) return ctx.reply(`More than one match:\n${hits.slice(0, 8).map((g) => `• ${g.subject}`).join('\n')}\nBe more specific.`);
        target = hits[0].id; title = hits[0].subject;
      }
      let url;
      try { url = await ctx.sock.profilePictureUrl(target, 'image'); } catch (_) { return ctx.reply("This group has no picture, or I can't see it."); }
      if (!url) return ctx.reply('This group has no picture.');
      const img = await http(url, { as: 'buffer', timeoutMs: 15000 });
      return ctx.sock.sendMessage(ctx.jid, { image: img, caption: title || undefined }, { quoted: ctx.msg });
    },
  },
  {
    // .jail @user [30m|2h|1d]  - Lumi deletes everything they send. Needs Lumi admin. Admins/owners are safe.
    name: 'jail', aliases: ['silence'], category: 'GROUP TOOLS', menu: ['jail @user [time]', 'unjail @user', 'jailed'],
    run: async (ctx) => {
      const info = await adminGuard(ctx);
      if (!info) return;
      const targets = targetsOf(ctx);
      if (!targets.length) return ctx.reply(`Tag who to jail, or reply to their message.\nExample: ${S.prefix()}jail @user 2h`);
      const timeArg = ctx.args.find((a) => /^\d+\s*(?:m|min|h|hr|d|days?)$/i.test(a));
      const ms = timeArg ? parseJailTime(timeArg) : 0;
      if (timeArg && !ms) return ctx.reply('Time can be 1m to 7d. Example: 30m, 2h, 1d.');
      const g = (store.jail[ctx.jid] ||= {});
      const prot = S.protectedIds();
      const done = []; const skipped = [];
      for (const t of targets) {
        const n = numberOf(t);
        const part = info.meta.participants.find((p) => idsOfPart(p).includes(n));
        const ids = uniq([n, ...(part ? idsOfPart(part) : [])]);
        if (info.botNumbers.some((b) => ids.includes(b)) || ids.some((x) => S.isOwner(x) || prot.includes(x))) { skipped.push('me/owner'); continue; }
        if (ids.some((x) => info.admins.has(x))) { skipped.push('an admin'); continue; }
        if (Object.keys(g).length >= MAX_JAILED_PER_GROUP && !g[ids[0]]) { skipped.push('(jail is full)'); continue; }
        g[ids[0]] = { ids, until: ms ? Date.now() + ms : 0, by: ctx.senderNum, at: Date.now() };
        done.push(ids[0]);
      }
      save();
      if (!done.length) return ctx.reply(`Can't jail ${skipped[0] || 'them'}. Pick someone else.`);
      return ctx.sock.sendMessage(ctx.jid, {
        text: `Jailed ${done.map((d) => `@${d}`).join(', ')}${ms ? ` for ${fmtJail(ms)}` : ''}. Everything they send gets deleted.${skipped.length ? `\nSkipped: ${skipped.join(', ')}.` : ''}`,
        mentions: done.map((d) => `${d}@s.whatsapp.net`),
      }, { quoted: ctx.msg });
    },
  },
  {
    name: 'unjail', aliases: ['free', 'release'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      const info = await adminGuard(ctx, { needBotAdmin: false });
      if (!info) return;
      const g = store.jail[ctx.jid] || {};
      if (/^all$/i.test(ctx.args[0] || '')) {
        const c = Object.keys(g).length; delete store.jail[ctx.jid]; save();
        return ctx.reply(c ? `Freed everyone (${c}).` : 'Nobody is jailed here.');
      }
      const targets = targetsOf(ctx);
      if (!targets.length) return ctx.reply(`Tag who to free, or: ${S.prefix()}unjail all`);
      let freed = 0;
      for (const t of targets) { const n = numberOf(t); for (const [k, r] of Object.entries(g)) if (k === n || r.ids.includes(n)) { delete g[k]; freed++; } }
      save();
      return ctx.reply(freed ? 'Freed. Behave.' : "They weren't jailed.");
    },
  },
  {
    name: 'jailed', aliases: ['jaillist'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const rows = Object.entries(store.jail[ctx.jid] || {}).filter(([, r]) => !r.until || r.until > Date.now());
      if (!rows.length) return ctx.reply('Nobody is jailed here.');
      return ctx.sock.sendMessage(ctx.jid, {
        text: `Jailed here:\n${rows.map(([k, r]) => `• @${k}${r.until ? ` (${fmtJail(r.until - Date.now())} left)` : ''}`).join('\n')}`,
        mentions: rows.map(([k]) => `${k}@s.whatsapp.net`),
      }, { quoted: ctx.msg });
    },
  },
  {
    // Saved stickers. Files live in DATA_DIR/stickers (use a volume on Railway or they vanish on redeploy).
    name: 'savesticker', aliases: ['ssave', 'stealsticker', 'addsticker'], category: 'STICKER TOOLS', menu: ['savesticker <name>'],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      const media = findMedia(ctx.msg, ['sticker']);
      if (!media) return ctx.reply(`Reply to a sticker with ${S.prefix()}savesticker <name>.`);
      if (!name) return ctx.reply(`Give it a name. Example: ${S.prefix()}savesticker laugh`);
      const items = store.stickers;
      if (items[name]) return ctx.reply(`"${name}" is taken. Pick another name.`);
      if (Object.keys(items).length >= STICKER_MAX_TOTAL) return ctx.reply('The sticker box is full.');
      if (!ctx.isOwner && Object.values(items).filter((i) => i.by === ctx.senderNum).length >= STICKER_MAX_PER_USER) return ctx.reply(`You already saved ${STICKER_MAX_PER_USER}. Delete one first.`);
      if ((Number(media.node.fileLength) || 0) > STICKER_MAX_BYTES) return ctx.reply('That sticker is too big (1 MB max).');
      let buf;
      try { buf = await downloadMedia(ctx.sock, media.source); } catch (_) { return ctx.reply("Couldn't download that sticker."); }
      if (!buf || !buf.length || buf.length > STICKER_MAX_BYTES) return ctx.reply("Couldn't save that sticker.");
      fs.mkdirSync(STICKER_DIR, { recursive: true });
      fs.writeFileSync(stickerFile(name), buf);
      items[name] = { by: ctx.senderNum, at: Date.now(), animated: Boolean(media.node.isAnimated) };
      save();
      return ctx.reply(`Saved as "${name}". Send it with ${S.prefix()}getsticker ${name}`);
    },
  },
  {
    name: 'getsticker', aliases: ['gs', 'sendsticker'], category: 'STICKER TOOLS', menu: ['getsticker <name>'],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      if (!name) return ctx.reply(`Which one? ${S.prefix()}stickers shows the list.`);
      if (!store.stickers[name] || !fs.existsSync(stickerFile(name))) return ctx.reply(`No sticker called "${name}".`);
      return ctx.sock.sendMessage(ctx.jid, { sticker: fs.readFileSync(stickerFile(name)) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'stickers', aliases: ['stickerlist', 'mystickers'], category: 'STICKER TOOLS', menu: ['stickers'],
    run: async (ctx) => {
      const names = Object.keys(store.stickers).sort();
      if (!names.length) return ctx.reply(`No saved stickers yet. Reply to one with ${S.prefix()}savesticker <name>.`);
      return ctx.reply(`Saved stickers (${names.length}):\n${names.map((n) => `• ${n}`).join('\n')}\n\nSend one: ${S.prefix()}getsticker <name>`);
    },
  },
  {
    name: 'delsticker', aliases: ['removesticker', 'unsavesticker'], category: 'STICKER TOOLS', menu: [],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      const it = store.stickers[name];
      if (!name || !it) return ctx.reply('No sticker with that name.');
      if (!ctx.isOwner && it.by !== ctx.senderNum) return ctx.reply('Only who saved it (or the owner) can delete it.');
      delete store.stickers[name];
      try { fs.unlinkSync(stickerFile(name)); } catch (_) { /* already gone */ }
      save();
      return ctx.reply(`Deleted "${name}".`);
    },
  },
];


// ---------- favorite stickers by mood ----------
// .fav [mood] (reply to a sticker, owner) / .favs / .sendfav [mood] / .unfav / .favmood / .favmode / .favauto
// The host's AI calls lumi.favMaybeSend(sock, msg, incomingText, answer) after it answers: sometimes she adds a fitting sticker.
// FAV_CHANCE (default 0.3), FAV_COOLDOWN_MS (default 90000). Files: DATA_DIR/stickers/fav.
const FAV_MOODS = ['laugh', 'love', 'sad', 'angry', 'hype', 'shock', 'cool', 'thanks', 'greet', 'sleepy', 'misc'];
const FAV_MAX_TOTAL = 150, FAV_MAX_PER_MOOD = 20, FAV_MAX_BYTES = 1024 * 1024;
const FAV_DIR = path.join(CONFIG.dataDir, 'stickers', 'fav');
const favFile = (id) => path.join(FAV_DIR, `${id}.webp`);
const favLastUse = new Map(); const favLastManual = new Map();
const FAV_RULES = [
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
function favMoodOf(text) { const t = String(text || ''); for (const [m, re] of FAV_RULES) if (re.test(t)) return m; return null; }
const favChance = () => { const n = parseFloat(process.env.FAV_CHANCE); return Number.isFinite(n) ? n : 0.3; };
const favCooldown = () => { const n = parseInt(process.env.FAV_COOLDOWN_MS, 10); return Number.isFinite(n) ? n : 90000; };
const favByMood = (m) => store.favs.items.filter((i) => i.mood === m);
const favPick = (a) => a[Math.floor(Math.random() * a.length)];
async function favDetectMood(buf, mime) {
  try {
    const res = await lookAtPicture(buf, mime, { system: 'You label WhatsApp stickers. Answer with ONE word only.', prompt: `What mood does this sticker express? Choose exactly one of: ${FAV_MOODS.filter((m) => m !== 'misc').join(', ')}. If none fits, answer misc.`, maxTokens: 10 });
    const words = ((res && res.text) || '').toLowerCase().match(/[a-z]+/g) || [];
    return words.find((w) => FAV_MOODS.includes(w)) || 'misc';
  } catch (_) { return 'misc'; }
}
async function favAdd(buf, mime, { mood, by = '', animated = false } = {}) {
  if (!buf || !buf.length || buf.length > FAV_MAX_BYTES) return { error: 'big' };
  const hash = require('crypto').createHash('sha1').update(buf).digest('hex');
  const dup = store.favs.items.find((i) => i.hash === hash); if (dup) return { error: 'dup', item: dup };
  if (store.favs.items.length >= FAV_MAX_TOTAL) return { error: 'full' };
  const m = FAV_MOODS.includes(mood) ? mood : await favDetectMood(buf, mime);
  if (favByMood(m).length >= FAV_MAX_PER_MOOD) return { error: 'mood-full', mood: m };
  const id = store.favs.items.reduce((n, i) => Math.max(n, i.id), 0) + 1;
  fs.mkdirSync(FAV_DIR, { recursive: true }); fs.writeFileSync(favFile(id), buf);
  const item = { id, mood: m, hash, by, at: Date.now(), animated: Boolean(animated) };
  store.favs.items.push(item); save(); return { item };
}
function favRemove(id) {
  const i = store.favs.items.findIndex((x) => x.id === id); if (i < 0) return false;
  store.favs.items.splice(i, 1); try { fs.unlinkSync(favFile(id)); } catch (_) { /* gone */ } save(); return true;
}
// Sometimes follows an answer with a favorite sticker that fits the mood. Returns true if one was sent.
async function favMaybeSend(sock, msg, incomingText = '', answer = '') {
  try {
    const jid = msg.key.remoteJid;
    if (store.favs.off[jid] || !store.favs.items.length) return false;
    const mood = favMoodOf(incomingText) || favMoodOf(answer); if (!mood) return false;
    const pool = favByMood(mood); if (!pool.length) return false;
    if (Math.random() >= favChance()) return false;
    if (Date.now() - (favLastUse.get(jid) || 0) < favCooldown()) return false;
    favLastUse.set(jid, Date.now());
    await humanSleep(humanOn() ? 700 + Math.random() * 1100 : 0);
    await sock.sendMessage(jid, { sticker: fs.readFileSync(favFile(favPick(pool).id)) });
    return true;
  } catch (e) { warn('favorite sticker failed:', e.message); return false; }
}
async function favAutoSave(sock, msg, ctx) {
  try {
    if (!store.favs.auto || !ctx.isOwner) return;
    const media = findMedia(msg, ['sticker']); if (!media || (Number(media.node.fileLength) || 0) > FAV_MAX_BYTES) return;
    await favAdd(await downloadMedia(sock, media.source), media.node.mimetype || 'image/webp', { by: ctx.senderNum, animated: media.node.isAnimated });
  } catch (_) { /* best effort */ }
}
const favMoodList = () => FAV_MOODS.join(', ');
const favCommands = [
  {
    name: 'fav', aliases: ['favsticker', 'favourite', 'favorite'], category: 'STICKER TOOLS', menu: ['fav [mood]'], ownerOnly: true,
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['sticker']);
      if (!media) return ctx.reply(`Reply to a sticker with ${S.prefix()}fav, and add a mood if you want: ${favMoodList()}`);
      const given = (ctx.args[0] || '').toLowerCase();
      if (given && !FAV_MOODS.includes(given)) return ctx.reply(`I don't know the mood "${given}". Pick one of: ${favMoodList()}`);
      if ((Number(media.node.fileLength) || 0) > FAV_MAX_BYTES) return ctx.reply('That sticker is too big (1 MB max).');
      let buf; try { buf = await downloadMedia(ctx.sock, media.source); } catch (_) { return ctx.reply("Couldn't download that sticker."); }
      const r = await favAdd(buf, media.node.mimetype || 'image/webp', { mood: given, by: ctx.senderNum, animated: media.node.isAnimated });
      if (r.error === 'dup') return ctx.reply(`Already in my favorites (#${r.item.id}, ${r.item.mood}).`);
      if (r.error === 'full') return ctx.reply(`My favorites are full (${FAV_MAX_TOTAL}). Remove some with ${S.prefix()}unfav.`);
      if (r.error === 'mood-full') return ctx.reply(`I already have ${FAV_MAX_PER_MOOD} "${r.mood}" stickers. Remove one or pick another mood.`);
      if (r.error) return ctx.reply("Couldn't save that one.");
      return ctx.reply(`Saved to favorites: #${r.item.id}, mood *${r.item.mood}* ⭐${given ? '' : `\n(Wrong mood? ${S.prefix()}favmood ${r.item.id} <mood>)`}`);
    },
  },
  {
    name: 'favs', aliases: ['favorites', 'favourites'], category: 'STICKER TOOLS', menu: ['favs'],
    run: async (ctx) => {
      const items = store.favs.items;
      if (!items.length) return ctx.reply(`No favorite stickers yet. Reply to a sticker with ${S.prefix()}fav.`);
      const m = (ctx.args[0] || '').toLowerCase();
      if (m && FAV_MOODS.includes(m)) { const l = favByMood(m); return ctx.reply(l.length ? `⭐ ${m} (${l.length}): ${l.map((i) => `#${i.id}`).join(' ')}` : `Nothing saved for "${m}".`); }
      const lines = FAV_MOODS.map((k) => [k, favByMood(k).length]).filter(([, n]) => n).map(([k, n]) => `• ${k}: ${n}`);
      return ctx.reply(`⭐ Favorite stickers (${items.length}):\n${lines.join('\n')}\n\nSee one: ${S.prefix()}sendfav <mood>`);
    },
  },
  {
    name: 'sendfav', aliases: ['favsend'], category: 'STICKER TOOLS', menu: [],
    run: async (ctx) => {
      if (!store.favs.items.length) return ctx.reply('No favorite stickers yet.');
      if (!ctx.isOwner && Date.now() - (favLastManual.get(ctx.jid) || 0) < 5000) return undefined;
      const m = (ctx.args[0] || '').toLowerCase();
      if (m && !FAV_MOODS.includes(m)) return ctx.reply(`Moods: ${favMoodList()}`);
      const pool = m ? favByMood(m) : store.favs.items;
      if (!pool.length) return ctx.reply(`I don't have a "${m}" sticker yet.`);
      favLastManual.set(ctx.jid, Date.now());
      return ctx.sock.sendMessage(ctx.jid, { sticker: fs.readFileSync(favFile(favPick(pool).id)) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'unfav', aliases: ['unfavorite', 'delfav'], category: 'STICKER TOOLS', menu: [], ownerOnly: true,
    run: async (ctx) => {
      let id = parseInt(String(ctx.args[0] || '').replace('#', ''), 10);
      if (!Number.isInteger(id)) {
        const media = findMedia(ctx.msg, ['sticker']);
        if (media) { try { const hash = require('crypto').createHash('sha1').update(await downloadMedia(ctx.sock, media.source)).digest('hex'); const it = store.favs.items.find((i) => i.hash === hash); if (it) id = it.id; } catch (_) { /* fall through */ } }
      }
      if (!Number.isInteger(id)) return ctx.reply(`Which one? ${S.prefix()}unfav <id> (see ${S.prefix()}favs), or reply to the sticker.`);
      return ctx.reply(favRemove(id) ? `Removed #${id} from favorites.` : `No favorite with id ${id}.`);
    },
  },
  {
    name: 'favmood', category: 'STICKER TOOLS', menu: [], ownerOnly: true,
    run: async (ctx) => {
      const id = parseInt(String(ctx.args[0] || '').replace('#', ''), 10); const m = (ctx.args[1] || '').toLowerCase();
      const it = store.favs.items.find((i) => i.id === id);
      if (!it || !FAV_MOODS.includes(m)) return ctx.reply(`Use: ${S.prefix()}favmood <id> <mood>\nMoods: ${favMoodList()}`);
      if (favByMood(m).length >= FAV_MAX_PER_MOOD) return ctx.reply(`"${m}" is full (${FAV_MAX_PER_MOOD}).`);
      it.mood = m; save(); return ctx.reply(`#${id} is now *${m}*.`);
    },
  },
  {
    name: 'favmode', category: 'STICKER TOOLS', menu: ['favmode on|off'], ownerOnly: true,
    run: async (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (a !== 'on' && a !== 'off') return ctx.reply(`Favorite stickers are ${store.favs.off[ctx.jid] ? 'off' : 'on'} in this chat. Use ${S.prefix()}favmode on or off.`);
      if (a === 'off') store.favs.off[ctx.jid] = true; else delete store.favs.off[ctx.jid];
      save(); return ctx.reply(a === 'on' ? "Okay. I'll drop a sticker here when the mood fits." : 'Okay. No stickers from me in this chat.');
    },
  },
  {
    name: 'favauto', category: 'STICKER TOOLS', menu: [], ownerOnly: true,
    run: async (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (a !== 'on' && a !== 'off') return ctx.reply(`Auto-saving your stickers is ${store.favs.auto ? 'on' : 'off'}. Use ${S.prefix()}favauto on or off.`);
      store.favs.auto = a === 'on'; save();
      return ctx.reply(a === 'on' ? "Okay. Every sticker you send, I'll save to my favorites and work out its mood." : "Okay. I'll stop auto-saving your stickers.");
    },
  },
];


// ---------- personality per chat ----------
// .persona warm|maki|calm|default (owner). The host's AI should call lumi.personaOf(jid) -> 'warm'|'maki'|'calm'|null
// and use it instead of the global PERSONALITY for that chat.
const PERSONA_MODES = ['warm', 'maki', 'calm'];
const personaOf = (jid) => (store.persona && store.persona[jid]) || null;
const personaCommands = [
  {
    name: 'persona', aliases: ['personality', 'mode'], category: 'AI SYSTEM', menu: ['persona'], ownerOnly: true,
    run: async (ctx) => {
      store.persona = store.persona || {};
      const a = (ctx.args[0] || '').toLowerCase(); const now = personaOf(ctx.jid);
      if (!a) return ctx.reply(`In this chat I'm *${now || CONFIG.personality}*${now ? '' : ' (the default)'}.\n\nChange it: ${S.prefix()}persona warm | maki | calm\nBack to default: ${S.prefix()}persona default`);
      if (['default', 'reset', 'off'].includes(a)) { delete store.persona[ctx.jid]; save(); return ctx.reply(`Back to my default personality here (${CONFIG.personality}).`); }
      if (!PERSONA_MODES.includes(a)) return ctx.reply(`Pick one: ${PERSONA_MODES.join(', ')} (or "default").`);
      store.persona[ctx.jid] = a; save();
      return ctx.reply({ warm: "Okay. Warm it is. I'll be nice here.", maki: 'Fine. Gloves off in this chat.', calm: 'Alright. Calm and quiet here.' }[a]);
    },
  },
];

// ---------- block list + backup ----------
// .block / .unblock / .blocklist (main owner): she ignores blocked people everywhere (and tries to block them on WhatsApp).
// .backup [full] (main owner, private chat): sends one JSON file with all her data. Login files are never included.
const blockedIdsOfMsg = (msg) => [...new Set([msg.key.participant, msg.key.participantAlt, msg.key.participantPn,
  msg.key.remoteJid && !String(msg.key.remoteJid).endsWith('@g.us') ? msg.key.remoteJid : null, msg.key.remoteJidAlt].filter(Boolean).map(numberOf))];
const isBlockedMsg = (msg) => !msg.key.fromMe && blockedIdsOfMsg(msg).some((n) => store.blocked && store.blocked[n]);
async function blockTargets(ctx) {
  const raw = [];
  for (const t of (ctx.taggedJids && ctx.taggedJids.length ? ctx.taggedJids : ctx.mentioned || [])) raw.push(numberOf(t));
  if (!raw.length && ctx.ctxInfo && ctx.ctxInfo.participant) raw.push(numberOf(ctx.ctxInfo.participant));
  if (!raw.length) for (const a of ctx.args) { const d = String(a).replace(/\D/g, ''); if (d.length >= 7 && d.length <= 16) raw.push(d); }
  let meta = null;
  if (ctx.isGroup && raw.length) { try { meta = await ctx.sock.groupMetadata(ctx.jid); } catch (_) { /* fine */ } }
  return [...new Set(raw)].map((n) => {
    const p = meta && meta.participants.find((x) => [x.id, x.lid, x.phoneNumber, x.jid].filter(Boolean).map(numberOf).includes(n));
    return [...new Set([n, ...(p ? [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf) : [])])];
  });
}
const BACKUP_MAX = 12 * 1024 * 1024;
// Passphrase: BACKUP_PASSPHRASE env (default DIVINE00), case matters; 3 wrong tries lock it for 10 minutes.
const backupPass = () => process.env.BACKUP_PASSPHRASE || 'DIVINE00';
const backupSame = (a, b) => { const h = (x) => require('crypto').createHash('sha256').update(String(x)).digest(); return require('crypto').timingSafeEqual(h(a), h(b)); };
const backupTries = new Map();
function collectStickerFiles(dir, out, base = dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) collectStickerFiles(p, out, base); else if (/\.webp$/i.test(e.name)) out[path.relative(base, p)] = fs.readFileSync(p).toString('base64'); }
}
function buildBackup(full) {
  const b = { app: 'lumi', version: 1, at: new Date().toISOString(), store: JSON.parse(JSON.stringify(store)) };
  if (full) { b.stickers = {}; collectStickerFiles(path.join(CONFIG.dataDir, 'stickers'), b.stickers); }
  return Buffer.from(JSON.stringify(b));
}
const blockCommands = [
  {
    name: 'block', aliases: ['ban'], category: 'OWNER', menu: ['block'], mainOwnerOnly: true,
    run: async (ctx) => {
      const groups = await blockTargets(ctx);
      if (!groups.length) return ctx.reply(`Tag them, reply to their message, or give a number.\nExample: ${S.prefix()}block 2348012345678`);
      const me = [ctx.sock.user && ctx.sock.user.id, ctx.sock.user && ctx.sock.user.lid].filter(Boolean).map(numberOf);
      const done = []; const skipped = [];
      for (const ids of groups) {
        if (ids.some((x) => S.isOwner(x) || S.protectedIds().includes(x) || me.includes(x))) { skipped.push('an owner/me'); continue; }
        if (ids.some((x) => store.blocked[x])) { skipped.push('already blocked'); continue; }
        if (Object.keys(store.blocked).length >= 500) { skipped.push('(list is full)'); continue; }
        for (const x of ids) store.blocked[x] = { at: Date.now(), by: ctx.senderNum };
        done.push(ids[0]);
        const phone = ids.find((x) => /^\d{7,15}$/.test(x));
        if (phone && ctx.sock.updateBlockStatus) ctx.sock.updateBlockStatus(`${phone}@s.whatsapp.net`, 'block').catch(() => {});
      }
      save();
      return ctx.reply([done.length ? `Blocked ${done.length}. I'll ignore ${done.length === 1 ? 'them' : 'them all'} everywhere.` : '', skipped.length ? `Skipped: ${skipped.join(', ')}.` : ''].filter(Boolean).join(' '));
    },
  },
  {
    name: 'unblock', aliases: ['unban'], category: 'OWNER', menu: ['unblock'], mainOwnerOnly: true,
    run: async (ctx) => {
      if ((ctx.args[0] || '').toLowerCase() === 'all') { const c = Object.keys(store.blocked).length; store.blocked = {}; save(); return ctx.reply(c ? 'Unblocked everyone.' : 'Nobody is blocked.'); }
      const groups = await blockTargets(ctx);
      if (!groups.length) return ctx.reply(`Tag them, reply to their message, give a number, or use ${S.prefix()}unblock all.`);
      let c = 0;
      for (const ids of groups) {
        if (!ids.some((x) => store.blocked[x])) continue;
        for (const x of ids) delete store.blocked[x];
        c++;
        const phone = ids.find((x) => /^\d{7,15}$/.test(x));
        if (phone && ctx.sock.updateBlockStatus) ctx.sock.updateBlockStatus(`${phone}@s.whatsapp.net`, 'unblock').catch(() => {});
      }
      save();
      return ctx.reply(c ? `Unblocked ${c}.` : "They weren't blocked.");
    },
  },
  {
    name: 'blocklist', aliases: ['blocked', 'banlist'], category: 'OWNER', menu: ['blocklist'], mainOwnerOnly: true,
    run: async (ctx) => {
      const all = Object.keys(store.blocked); const nums = all.filter((n) => /^\d{7,15}$/.test(n));
      if (!all.length) return ctx.reply('Nobody is blocked.');
      return ctx.reply(`Blocked (${nums.length}${all.length > nums.length ? ' + some hidden IDs' : ''}):\n${nums.map((n) => `• +${n}`).join('\n') || '(only hidden IDs)'}`);
    },
  },
  {
    name: 'backup', aliases: ['exportdata'], category: 'OWNER', menu: ['backup'], mainOwnerOnly: true,
    run: async (ctx) => {
      if (ctx.isGroup) return ctx.reply(`Do that in a private chat with me. A backup holds everything: ${S.prefix()}backup`);
      const t = backupTries.get(ctx.senderNum) || { n: 0, until: 0 };
      if (t.until > Date.now()) return ctx.reply(`Locked for ${Math.ceil((t.until - Date.now()) / 60000)} more minute(s) after too many wrong tries.`);
      const full = (ctx.args[0] || '').toLowerCase() === 'full';
      const given = (full ? ctx.args.slice(1) : ctx.args).join(' ').trim();
      if (!given) return ctx.reply(`Passphrase needed: ${S.prefix()}backup <passphrase>   or   ${S.prefix()}backup full <passphrase>`);
      if (!backupSame(given, backupPass())) { t.n += 1; if (t.n >= 3) { t.until = Date.now() + 10 * 60 * 1000; t.n = 0; } backupTries.set(ctx.senderNum, t); return ctx.reply('Wrong passphrase.'); }
      backupTries.delete(ctx.senderNum);
      let buf = buildBackup(full); let note = '';
      if (buf.length > BACKUP_MAX) { buf = buildBackup(false); note = '\n(Too big with the stickers, so this one has settings only.)'; }
      await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'application/json', fileName: `lumi-backup-${new Date().toISOString().slice(0, 10)}${full && !note ? '-full' : ''}.json`, caption: `Backup, ${Math.round(buf.length / 1024)} KB.${note}\nKeep it private. It has no login files.` }, { quoted: ctx.msg });
      return undefined;
    },
  },
];

const commandList = [
  // GENERAL
  { name: 'menu', category: 'GENERAL', menu: ['menu'], run: sendMenu },
  { name: 'help', category: 'GENERAL', menu: ['help'], run: sendMenu },
  {
    name: 'ping', category: 'GENERAL', menu: ['ping'],
    run: (ctx) => ctx.reply(`Online. ${Math.max(0, Date.now() - Number(ctx.msg.messageTimestamp) * 1000)} ms.`), // approximate: WhatsApp timestamps are 1 s precision
  },
  {
    name: 'about', category: 'GENERAL', menu: ['about'],
    run: (ctx) => ctx.reply(
      `*Lumi* v${CONFIG.version}\n` +
      `${CONFIG.personality === 'calm' ? 'Calm, observant, a little sarcastic.' : CONFIG.personality === 'maki' ? 'Blunt, dry, unbothered.' : 'Warm and friendly to everyone, until you insult or annoy her.'} Quietly looks out for ${CONFIG.ownerName}.\n\n` +
      `Prefix: ${S.prefix()}\nType ${S.prefix()}menu to see what I can do.`),
  },
  {
    name: 'status', category: 'GENERAL', menu: ['status'],
    run: (ctx) => ctx.reply(
      `*Status*\nUptime: ${fmtUptime(Math.floor(process.uptime()))}\n` +
      `AI in this chat: ${S.isAiOn(ctx.jid) ? 'on' : 'off'}\n` +
      `${CONFIG.ownerName} protection: ${S.isProtectOn() && S.protectedIds().length ? 'on' : 'off'}`),
  },
  {
    name: 'owner', category: 'GENERAL', menu: ['owner'],
    run: (ctx) => {
      let t = `Owner: ${CONFIG.ownerName}`;
      if (CONFIG.showOwnerNumber && CONFIG.ownerIds[0]) t += `\nhttps://wa.me/${CONFIG.ownerIds[0]}`;
      return ctx.reply(t);
    },
  },

  // AI SYSTEM
  {
    name: 'chatbot', aliases: ['ai'], category: 'AI SYSTEM', menu: ['chatbot on', 'chatbot off'],
    run: (ctx) => {
      const arg = (ctx.args[0] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') return ctx.reply('Use chatbot on or chatbot off.');
      if (ctx.isGroup && !ctx.isOwner) return ctx.reply('Only the owner can switch that in groups.');
      S.setAi(ctx.jid, arg === 'on');
      return ctx.reply(arg === 'on' ? 'Chatbot is on for this chat.' : 'Chatbot is off here. Commands still work.');
    },
  },
  {
    name: 'clear', category: 'AI SYSTEM', menu: ['clear'],
    run: (ctx) => { if (hooks.clearMemory) hooks.clearMemory(ctx.senderNum); return ctx.reply("Done. I've forgotten our conversation."); },
  },
  {
    name: 'protect', category: 'AI SYSTEM', menu: ['protect on', 'protect off'], ownerOnly: true,
    run: (ctx) => {
      const arg = (ctx.args[0] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') return ctx.reply('Use protect on or protect off.');
      S.setProtect(arg === 'on');
      return ctx.reply(`Protection is ${arg}.`);
    },
  },
  {
    name: 'affinity', aliases: ['bond'], category: 'AI SYSTEM', menu: ['affinity [@user]'],
    run: (ctx) => {
      const t = targetNumbers(ctx)[0];
      const num = t || ctx.senderNum;
      const a = getAffinity(num);
      const who = t && t !== ctx.senderNum ? `@${num}` : 'You';
      const next = a.next ? `\n${a.next.need} more until "${a.next.level}".` : '\nThat is the top. Do not let it go to your head.';
      const mentions = ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []);
      return ctx.reply(`*Affinity*\n${who}: ${a.level} (${a.pts} pts)${next}`, who === 'You' ? {} : { mentions });
    },
  },

  // STICKER TOOLS
  { name: 's', aliases: ['sticker'], category: 'STICKER TOOLS', menu: ['s'], run: makeSticker },
  { name: 'take', category: 'STICKER TOOLS', menu: ['take'], run: takeSticker },
  { name: 'toimg', category: 'STICKER TOOLS', menu: ['toimg'], run: stickerToImage },

  // MEDIA
  { name: 'play', category: 'MEDIA', menu: ['play'], run: play },
  {
    name: 'tomp3', aliases: ['mp3'], category: 'MEDIA', menu: ['tomp3'],
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['video', 'audio']);
      if (!media) return ctx.reply(`Reply to a video or a voice note with ${S.prefix()}tomp3`);
      if (Number(media.node.fileLength) > 40 * 1024 * 1024) return ctx.reply('That file is too big (40 MB max).');
      await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
      const buf = await downloadMedia(ctx.sock, media.source);
      let mp3;
      try { mp3 = await toMp3(buf); } catch (_) { return ctx.reply("I can't convert audio on this server (ffmpeg is missing)."); }
      return ctx.sock.sendMessage(ctx.jid, { audio: mp3, mimetype: 'audio/mpeg', ptt: false }, { quoted: ctx.msg });
    },
  },

  {
    name: 'voice', aliases: ['tts', 'say'], category: 'MEDIA', menu: ['voice <text>', 'voice fr: bonjour'],
    run: async (ctx) => {
      const q = ctx.ctxInfo?.quotedMessage ? getText(unwrap(ctx.ctxInfo.quotedMessage)) : '';
      let lang = 'en', text = ctx.argText || q;
      const m = /^([a-z]{2})\s*[:,]?\s+(.+)$/is.exec(ctx.argText);
      if (m && VOICE_LANGS.has(m[1].toLowerCase())) { lang = m[1].toLowerCase(); text = m[2]; }
      if (!text) return ctx.reply(`Give me something to say.\nExample: ${S.prefix()}voice good morning everyone\nOr reply to a message with ${S.prefix()}voice. Languages: ${[...VOICE_LANGS].join(' ')}`);
      if (text.length > 500) return ctx.reply('That is too long for a voice note (500 characters max).');
      if (!ctx.isOwner) {
        const wait = 15000 - (Date.now() - (voiceUse.get(ctx.senderNum) || 0));
        if (wait > 0) return ctx.reply(`Give me ${Math.ceil(wait / 1000)} seconds.`);
        voiceUse.set(ctx.senderNum, Date.now());
      }
      try {
        const mp3 = await synthesize(text, lang);
        let content;
        try { content = { audio: await toVoiceNote(mp3), mimetype: 'audio/ogg; codecs=opus', ptt: true }; }
        catch (_) { content = { audio: mp3, mimetype: 'audio/mpeg', ptt: false }; }
        return ctx.sock.sendMessage(ctx.jid, content, { quoted: ctx.msg });
      } catch (e) { warn('voice failed:', e.message); return ctx.reply("My voice isn't working right now. Try again in a bit."); }
    },
  },

  {
    // .creategc Study Group  |  .creategc Study Group 2348012345678 2349087654321 (up to 10 people, you become admin)
    name: 'creategc', aliases: ['newgc', 'creategroup'], category: 'OWNER', menu: ['creategc <name> [numbers]'], ownerOnly: true,
    run: async (ctx) => {
      const isNum = (a) => /^\+?\d[\d-]*$/.test(a) && a.replace(/\D/g, '').length >= 7 && a.replace(/\D/g, '').length <= 15;
      const nums = ctx.args.filter(isNum).map((a) => a.replace(/\D/g, ''));
      const name = ctx.args.filter((a) => !isNum(a)).join(' ').trim();
      if (!name) return ctx.reply(`Give the group a name.\nExample: ${S.prefix()}creategc Study Group\nTo add people too: ${S.prefix()}creategc Study Group 2348012345678 2349087654321`);
      if (name.length > 100) return ctx.reply('Group names are 100 characters max.');
      const wait = 30000 - (Date.now() - lastCreateAt);
      if (wait > 0) return ctx.reply(`Slow down. WhatsApp bans accounts that create groups too fast. Try again in ${Math.ceil(wait / 1000)} seconds.`);
      const k = ctx.msg.key;
      const owner = [k.participantPn, k.participantAlt, k.remoteJidAlt, ctx.sender, ctx.jid].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender;
      const bots = botNumbers(ctx.sock);
      const members = uniq([owner, ...nums.map((n) => `${n}@s.whatsapp.net`), ...ctx.mentioned]).filter((j) => !bots.includes(numberOf(j)));
      if (members.length > 11) return ctx.reply('That is too many people at once (10 max). Add the rest after.');
      lastCreateAt = Date.now();
      let created;
      try { created = await ctx.sock.groupCreate(name, members); } catch (e) { lastCreateAt = 0; warn('creategc failed:', e.message); return ctx.reply("WhatsApp wouldn't let me create it. Check the numbers are on WhatsApp, or try again in a bit."); }
      const id = created && created.id;
      if (!id) return ctx.reply("It didn't create properly. Check WhatsApp before trying again.");
      await ctx.sock.groupParticipantsUpdate(id, [owner], 'promote').catch(() => {});
      let link = '';
      try { link = `https://chat.whatsapp.com/${await ctx.sock.groupInviteCode(id)}`; } catch (_) {}
      return ctx.reply(`Created *${name}* with ${members.length} ${members.length === 1 ? 'person' : 'people'}.${link ? `\nLink: ${link}` : `\nI couldn't get the link yet. Send ${S.prefix()}gclink ${name} in a moment.`}\nYou're an admin there.`);
    },
  },
  {
    // .gclink: in a group = its link; in a private chat = lists my groups.  .gclink <name> = link of any group I'm admin in.
    name: 'gclink', aliases: ['grouplink', 'getlink'], category: 'OWNER', menu: ['gclink [group name]'], ownerOnly: true,
    run: async (ctx) => {
      const NO_ADMIN = "I'm not an admin there, and WhatsApp only gives links to admins. Make me an admin first.";
      const link = async (jid) => `https://chat.whatsapp.com/${await ctx.sock.groupInviteCode(jid)}`;
      const q = ctx.argText.trim().toLowerCase();
      if (!q && ctx.isGroup) { try { return await ctx.reply(`Group link:\n${await link(ctx.jid)}`); } catch (_) { return ctx.reply(NO_ADMIN); } }
      const bots = botNumbers(ctx.sock);
      const botAdmin = (m) => (m.participants || []).some((p) => p.admin && [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf).some((n) => bots.includes(n)));
      const all = Object.values(await ctx.sock.groupFetchAllParticipating()).sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
      if (!all.length) return ctx.reply("I'm not in any groups.");
      if (!q) {
        const lines = all.slice(0, 30).map((m, i) => `${i + 1}. ${m.subject}${botAdmin(m) ? '' : ' (not admin)'}`);
        return ctx.reply(`*My groups*\n${lines.join('\n')}${all.length > 30 ? `\n...and ${all.length - 30} more` : ''}\n\nGet a link: ${S.prefix()}gclink <group name>`);
      }
      const exact = all.filter((m) => String(m.subject).toLowerCase() === q);
      const hits = exact.length ? exact : all.filter((m) => String(m.subject).toLowerCase().includes(q));
      if (!hits.length) return ctx.reply(`I'm not in a group called "${ctx.argText}". Send ${S.prefix()}gclink to see the list.`);
      if (hits.length > 1) return ctx.reply(`More than one match. Be more specific:\n${hits.slice(0, 10).map((m) => `• ${m.subject}`).join('\n')}`);
      if (!botAdmin(hits[0])) return ctx.reply(`${NO_ADMIN} (${hits[0].subject})`);
      try { return await ctx.reply(`*${hits[0].subject}*\n${await link(hits[0].id)}`); } catch (_) { return ctx.reply(`${NO_ADMIN} (${hits[0].subject})`); }
    },
  },
  ...funCommands,
  ...autoreadCommands,
  ...socialCommands,
  ...visionCommands,
  ...imagineCommands,
  ...favCommands,
  ...personaCommands,
  ...blockCommands,
  {
    name: 'setvoice', category: 'OWNER', menu: ['setvoice <name>'], ownerOnly: true,
    run: (ctx) => {
      const found = GEMINI_VOICES.find((n) => n.toLowerCase() === (ctx.args[0] || '').toLowerCase());
      if (!ctx.args[0]) return ctx.reply(`My voice: ${voiceName()}${geminiOn() ? '' : ' (Gemini voice is off: no GEMINI_API_KEY)'}\nChange it: ${S.prefix()}setvoice <name>\n\n${GEMINI_VOICES.join(', ')}`);
      if (!found) return ctx.reply(`I don't know a voice called "${ctx.args[0]}". Send ${S.prefix()}setvoice to see the list.`);
      store.voiceName = found; save();
      return ctx.reply(`Voice set to ${found}. Try ${S.prefix()}voice hello, this is my new voice.`);
    },
  },

  // DOWNLOAD
  { name: 'dl', aliases: ['download'], category: 'DOWNLOAD', menu: ['dl <link>', 'dl <link> audio'], run: download },

  // PROFILE
  {
    name: 'getpp', category: 'PROFILE', menu: ['getpp @user'],
    run: async (ctx) => {
      const target = ctx.mentioned[0] || ctx.ctxInfo?.participant || (!ctx.isGroup ? ctx.jid : null);
      if (!target) return ctx.reply(`Tag someone: ${S.prefix()}getpp @user`);
      let url;
      try { url = await ctx.sock.profilePictureUrl(target, 'image'); } catch (_) {
        return ctx.reply("I can't get that picture. They may not have one, or they've hidden it.");
      }
      if (!url) return ctx.reply('No profile picture available.');
      const img = await http(url, { as: 'buffer', timeoutMs: 15000 });
      return ctx.sock.sendMessage(ctx.jid, { image: img }, { quoted: ctx.msg });
    },
  },

  // GROUP TOOLS
  {
    name: 'add', category: 'GROUP TOOLS', menu: ['add <number>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      const nums = ctx.args.map((a) => a.replace(/\D/g, '')).filter((n) => n.length >= 7 && n.length <= 15);
      if (!nums.length) return ctx.reply(`Give me a number with country code.\nExample: ${S.prefix()}add 2348012345678`);
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, nums.map((n) => `${n}@s.whatsapp.net`), 'add');
      const status = { 200: 'added', 403: 'their privacy settings block adding them', 408: 'they left recently and cannot be re-added yet', 409: 'already in the group' };
      return ctx.reply((res || []).map((r) => `${numberOf(r.jid)}: ${status[r.status] || `failed (${r.status})`}`).join('\n') || 'Nothing happened.');
    },
  },
  {
    name: 'kick', category: 'GROUP TOOLS', menu: ['kick @user'],
    run: async (ctx) => {
      const info = await adminGuard(ctx);
      if (!info) return;
      const targets = uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
      if (!targets.length) return ctx.reply(`Tag who to remove, or reply to their message.\nExample: ${S.prefix()}kick @user`);
      const prot = S.protectedIds();
      const blocked = targets.some((j) => { const n = numberOf(j); return info.botNumbers.includes(n) || S.isOwner(n) || prot.includes(n); });
      if (blocked) return ctx.reply('Not him. Not me either. Pick someone else.');
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'remove');
      const failed = (res || []).filter((r) => String(r.status) !== '200');
      return ctx.reply(failed.length ? "Couldn't remove everyone. Admins can't be removed by me." : 'Gone.');
    },
  },
  {
    // Tags everyone silently. Reply to a message/media and it is re-sent with the hidden tags. Bot need not be admin.
    name: 'hidetag', aliases: ['htag', 'tagall'], category: 'GROUP TOOLS', menu: ['hidetag [text]'],
    run: async (ctx) => {
      const info = await adminGuard(ctx, { needBotAdmin: false });
      if (!info) return;
      const mentions = uniq(info.meta.participants.map((p) => p.id).filter(Boolean));
      const q = ctx.ctxInfo?.quotedMessage;
      const text = ctx.argText || (q ? getText(unwrap(q)) : '') || '';
      const media = findMedia(ctx.msg, ['image', 'video', 'audio', 'sticker']);
      if (media) {
        if (Number(media.node.fileLength) > 30 * 1024 * 1024) return ctx.reply('That file is too big (30 MB max).');
        const buf = await downloadMedia(ctx.sock, media.source);
        const content =
          media.kind === 'image' ? { image: buf, caption: text, mentions } :
          media.kind === 'video' ? { video: buf, caption: text, mentions } :
          media.kind === 'audio' ? { audio: buf, mimetype: media.node.mimetype || 'audio/mp4', ptt: Boolean(media.node.ptt), mentions } :
          { sticker: buf, mentions };
        return ctx.sock.sendMessage(ctx.jid, content);
      }
      return ctx.sock.sendMessage(ctx.jid, { text: text || '📢', mentions });
    },
  },
  {
    name: 'promote', category: 'GROUP TOOLS', menu: ['promote @user'],
    run: (ctx) => updateMembers(ctx, 'promote', "Done. They're an admin now. Don't make me regret it.", `Tag who to promote, or reply to their message.\nExample: ${S.prefix()}promote @user`),
  },
  {
    name: 'demote', category: 'GROUP TOOLS', menu: ['demote @user'],
    run: (ctx) => updateMembers(ctx, 'demote', 'Done. Back to normal member.', `Tag who to demote, or reply to their message.\nExample: ${S.prefix()}demote @user`),
  },
  {
    name: 'link', category: 'GROUP TOOLS', menu: ['link'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      return ctx.reply(`Group link:\nhttps://chat.whatsapp.com/${await ctx.sock.groupInviteCode(ctx.jid)}`);
    },
  },
  {
    name: 'revoke', aliases: ['resetlink'], category: 'GROUP TOOLS', menu: ['revoke'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      await ctx.sock.groupRevokeInvite(ctx.jid);
      return ctx.reply(`Old link is dead. ${S.prefix()}link for the new one.`);
    },
  },
  groupSetting('mute', 'announcement', 'Group muted. Only admins can talk now. Peaceful.'),
  groupSetting('unmute', 'not_announcement', 'Group unmuted. Everyone can talk again. Unfortunately.'),
  groupSetting('lock', 'locked', 'Group info locked. Only admins can edit it.'),
  groupSetting('unlock', 'unlocked', 'Group info unlocked. Everyone can edit it.'),
  {
    name: 'setname', category: 'GROUP TOOLS', menu: ['setname <name>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new name.\nExample: ${S.prefix()}setname Lumi Squad`);
      if (ctx.argText.length > 100) return ctx.reply('Group names are 100 characters max.');
      await ctx.sock.groupUpdateSubject(ctx.jid, ctx.argText);
      return ctx.reply('Name changed.');
    },
  },
  {
    name: 'setdesc', category: 'GROUP TOOLS', menu: ['setdesc <text>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new description.\nExample: ${S.prefix()}setdesc Be nice here`);
      await ctx.sock.groupUpdateDescription(ctx.jid, ctx.argText);
      return ctx.reply('Description changed.');
    },
  },
  {
    name: 'admins', category: 'GROUP TOOLS', menu: ['admins'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const meta = await ctx.sock.groupMetadata(ctx.jid);
      const admins = (meta.participants || []).filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
      if (!admins.length) return ctx.reply('No admins. Anarchy.');
      const lines = admins.map((p) => `┃ ${p.admin === 'superadmin' ? '👑' : '🛡️'} @${numberOf(p.phoneNumber || p.id)}`).join('\n');
      return ctx.sock.sendMessage(ctx.jid, { text: `╭━━━「 ADMINS 」\n${lines}\n╰━━━━━━━━━━━━`, mentions: admins.map((p) => p.phoneNumber || p.id) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'groupinfo', aliases: ['ginfo'], category: 'GROUP TOOLS', menu: ['groupinfo'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const m = await ctx.sock.groupMetadata(ctx.jid);
      const people = m.participants || [];
      const created = m.creation ? new Date(m.creation * 1000).toLocaleDateString() : 'Unknown';
      return ctx.reply(
        `╭━━━「 GROUP INFO 」\n┃ Name: ${m.subject}\n┃ Members: ${people.length}\n┃ Admins: ${people.filter((p) => p.admin).length}\n` +
        `┃ Created: ${created}\n┃ Description: ${m.desc || 'None'}\n╰━━━━━━━━━━━━`);
    },
  },
  {
    // .recap [group] [time]  e.g. .recap, .recap 6h, .recap today, .recap 300 (messages), in a group; or from a private chat with the
    // owner: .recap (list), .recap 2 today, .recap <group name> 6h. Long chats are summarised in parts, then combined.
    name: 'recap', aliases: ['summary'], category: 'GROUP TOOLS', menu: ['recap [group] [time]'],
    run: async (ctx) => {
      if (!hooks.generate) return ctx.reply("My AI isn't hooked up here, so no recap.");
      const args = [...ctx.args]; let range = null;
      if (args.length && recapRange(args[args.length - 1])) range = recapRange(args.pop());
      let jid = ctx.isGroup ? ctx.jid : null;
      if (!ctx.isGroup) {
        const ordered = clJids().sort((a, b) => clLastAt(b) - clLastAt(a));
        if (!args.length) {
          if (!ctx.isOwner) return ctx.reply(`Tell me which group: ${S.prefix()}recap <group name> today`);
          if (!ordered.length) return ctx.reply("I haven't seen any group messages yet. I only keep notes while I'm in the group.");
          const rows = []; for (const j of ordered) rows.push({ j, name: await recapSubject(ctx.sock, j) });
          return ctx.reply(`Groups I have notes on:\n${rows.map((r, i) => `${i + 1}. ${r.name} (${clFresh(r.j).length} msgs, last ${recapAgo(Date.now() - clLastAt(r.j))})`).join('\n')}\n\nExample: ${S.prefix()}recap 1 today`);
        }
        const pick = args.join(' ').trim().toLowerCase();
        if (/^\d+$/.test(pick) && ordered[parseInt(pick, 10) - 1]) jid = ordered[parseInt(pick, 10) - 1];
        else { const hits = []; for (const j of ordered) if ((await recapSubject(ctx.sock, j)).toLowerCase().includes(pick)) hits.push(j); if (hits.length > 1) return ctx.reply(`More than one group matches "${pick}". Use the number from ${S.prefix()}recap.`); jid = hits[0] || null; }
        if (!jid) return ctx.reply(`I don't have notes on a group like that. ${S.prefix()}recap shows the list.`);
        if (!ctx.isOwner) {
          let ok = false; try { const meta = await ctx.sock.groupMetadata(jid); ok = meta.participants.some((p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf).includes(ctx.senderNum)); } catch (_) { /* not a member */ }
          if (!ok) return ctx.reply("You're not in that group, so no recap for you.");
        }
      }
      range = range || { since: Date.now() - 86400000, label: 'last 24h' };
      let rows = range.count ? clLast(jid, range.count) : clSince(jid, range.since);
      if (range.until) rows = rows.filter((r) => r.ts < range.until);
      if (rows.length < 5) return ctx.reply(`Not enough to recap${range.label ? ` for ${range.label}` : ''} (${rows.length} message${rows.length === 1 ? '' : 's'}). I only keep what I saw while in the group.${clFirstAt(jid) ? ` My notes start ${recapStamp(clFirstAt(jid))}. Try ${S.prefix()}recap 3d.` : ''}`);
      if (!ctx.isOwner && Date.now() - (recapAt.get(jid) || 0) < 30000) return ctx.reply('I just did one. Give it 30 seconds.');
      if (!ctx.isOwner) recapAt.set(jid, Date.now());
      const title = await recapSubject(ctx.sock, jid);
      await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
      let out; try { out = await recapSummarise(rows, title); } finally { await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {}); }
      if (!out) return ctx.reply("My head's a bit foggy right now. Try me again in a minute.");
      const first = clFirstAt(jid);
      const early = !range.count && range.since && first && first > range.since + 3600000 ? `\n_(I only have notes from ${recapStamp(first)}. I can't see older messages.)_` : '';
      const warn = out.skipped ? '\n_(It was a lot, so the oldest part was skipped. Try a shorter range for that part.)_' : '';
      return ctx.reply(`*Recap: ${title}*${range.label ? ` (${range.label})` : ''}\n_${recapStamp(rows[0].ts)} to ${recapStamp(rows[rows.length - 1].ts)}_\n\n${out.text}\n\n${recapStats(rows)}${early}${warn}`);
    },
  },

  // GAMES
  {
    name: 'rps', category: 'GAMES', menu: ['rps <rock|paper|scissors>'],
    run: (ctx) => {
      const you = RPS_ALIAS[(ctx.args[0] || '').toLowerCase()];
      if (!you) return ctx.reply(`Pick one: ${P()}rps rock | paper | scissors`);
      const me = pick(Object.keys(RPS));
      let verdict;
      if (you === me) verdict = 'Draw. Again.';
      else if (BEATS[you] === me) { win(ctx); verdict = pick(['You win. Enjoy it.', 'Fine. You got that one.']); }
      else verdict = pick(['I win.', 'Too easy.']);
      return ctx.reply(`${RPS[you]} vs ${RPS[me]}\n${verdict}`);
    },
  },
  {
    name: 'dice', aliases: ['roll'], category: 'GAMES', menu: ['dice [sides]'],
    run: (ctx) => {
      const sides = parseInt(ctx.args[0], 10) || 6;
      if (sides < 2 || sides > 1000) return ctx.reply('Between 2 and 1000 sides.');
      return ctx.reply(`🎲 ${1 + rnd(sides)}  (d${sides})`);
    },
  },
  { name: 'flip', aliases: ['coin', 'coinflip'], category: 'GAMES', menu: ['flip'], run: (ctx) => ctx.reply(`🪙 ${pick(['Heads.', 'Tails.'])}`) },
  {
    name: '8ball', aliases: ['ball'], category: 'GAMES', menu: ['8ball <question>'],
    run: (ctx) => (ctx.argText ? ctx.reply(`🎱 ${pick(BALL)}`) : ctx.reply(`Ask something. Example: ${P()}8ball will I pass`)),
  },
  {
    name: 'slots', aliases: ['slot'], category: 'GAMES', menu: ['slots'],
    run: (ctx) => {
      const r = [pick(REEL), pick(REEL), pick(REEL)];
      const line = `🎰 ${r.join(' | ')}`;
      if (r[0] === r[1] && r[1] === r[2]) { win(ctx); return ctx.reply(`${line}\nJackpot. Don't look so smug.`); }
      if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) return ctx.reply(`${line}\nAlmost. Pull again.`);
      return ctx.reply(`${line}\nNothing. Predictable.`);
    },
  },
  {
    name: 'guess', category: 'GAMES', menu: ['guess', 'guess <number>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      const g = live(guessGames, ctx.jid);
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        guessGames.delete(ctx.jid);
        return ctx.reply(`It was ${g.n}. Giving up already?`);
      }
      if (!a) {
        if (g) return ctx.reply(`A game is on. Guess 1-100 with ${P()}guess <number>. Tries used: ${g.tries}/${GUESS_MAX}.`);
        guessGames.set(ctx.jid, { n: 1 + rnd(100), tries: 0, at: Date.now() });
        return ctx.reply(`I'm thinking of a number from 1 to 100. ${GUESS_MAX} tries, everyone shares them.\nGuess with ${P()}guess <number>`);
      }
      if (!/^\d{1,3}$/.test(a)) return ctx.reply(`Use a number: ${P()}guess 42`);
      if (!g) return ctx.reply(`No game running. Start one with ${P()}guess`);
      const n = parseInt(a, 10);
      g.tries += 1; g.at = Date.now();
      if (n === g.n) { guessGames.delete(ctx.jid); win(ctx); return ctx.reply(`${n}. Yes. Took ${g.tries} ${g.tries === 1 ? 'try' : 'tries'}.`); }
      if (g.tries >= GUESS_MAX) { guessGames.delete(ctx.jid); return ctx.reply(`Out of tries. It was ${g.n}.`); }
      return ctx.reply(`${n < g.n ? 'Higher.' : 'Lower.'} (${g.tries}/${GUESS_MAX})`);
    },
  },
  {
    name: 'math', aliases: ['quiz'], category: 'GAMES', menu: ['math', 'math <answer>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').trim();
      let g = live(mathGames, ctx.jid, 2 * 60 * 1000);
      if (!a) {
        if (!g) { g = { ...mathQuestion(), at: Date.now() }; mathGames.set(ctx.jid, g); }
        return ctx.reply(`🧮 ${g.q} = ?\nAnswer with ${P()}math <number>. First right answer wins.`);
      }
      if (!/^-?\d+$/.test(a)) return ctx.reply(`Use a number: ${P()}math 42`);
      if (!g) return ctx.reply(`No question running. Start one with ${P()}math`);
      if (parseInt(a, 10) !== g.a) return ctx.reply('No.');
      mathGames.delete(ctx.jid); win(ctx);
      return ctx.reply(`${g.q} = ${g.a}. Right. First one there.`);
    },
  },
  {
    name: 'ttt', aliases: ['tictactoe'], category: 'GAMES', menu: ['ttt @user', 'ttt <1-9>'],
    run: (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only. I need two people.');
      const g = live(tttGames, ctx.jid);
      const a = (ctx.args[0] || '').toLowerCase();
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        if (![g.x, g.o].includes(ctx.senderNum) && !ctx.isOwner) return ctx.reply("It's not your game.");
        tttGames.delete(ctx.jid);
        return ctx.reply('Game over. Nobody wins.');
      }
      if (/^[1-9]$/.test(a)) {
        if (!g) return ctx.reply(`No game here. Start one: ${P()}ttt @user`);
        const mark = g.x === ctx.senderNum ? 'x' : g.o === ctx.senderNum ? 'o' : null;
        if (!mark) return ctx.reply("You're not in this game.");
        if (g.turn !== mark) return ctx.reply('Not your turn.');
        const i = parseInt(a, 10) - 1;
        if (g.board[i]) return ctx.reply('That square is taken.');
        g.board[i] = mark; g.at = Date.now();
        const w = winnerOf(g.board);
        if (w) { tttGames.delete(ctx.jid); win(ctx); return tttSend(ctx, g, `${w === 'x' ? '❌' : '⭕'} @${ctx.senderNum} wins.`); }
        if (g.board.every(Boolean)) { tttGames.delete(ctx.jid); return tttSend(ctx, g, 'Draw. Boring.'); }
        g.turn = mark === 'x' ? 'o' : 'x';
        return tttSend(ctx, g, `${g.turn === 'x' ? '❌' : '⭕'} @${g.turn === 'x' ? g.x : g.o}, your move. (${P()}ttt <1-9>)`);
      }
      if (g) return ctx.reply(`A game is already running here. ${P()}ttt end stops it.`);
      const target = ctx.mentioned[0] || ctx.ctxInfo?.participant;
      if (!target) return ctx.reply(`Tag who you want to play.\nExample: ${P()}ttt @user`);
      const o = numberOf(target);
      if (botNumbers(ctx.sock).includes(o)) return ctx.reply("I don't play. I'd win and you'd sulk.");
      if (o === ctx.senderNum) return ctx.reply('Playing yourself? Pick someone else.');
      const game = { x: ctx.senderNum, o, xJid: ctx.sender, oJid: target, board: Array(9).fill(null), turn: 'x', at: Date.now() };
      tttGames.set(ctx.jid, game);
      return tttSend(ctx, game, `❌ @${game.x} vs ⭕ @${game.o}\n@${game.x} starts. Play with ${P()}ttt <1-9>`);
    },
  },
  {
    name: 'hangman', aliases: ['hm'], category: 'GAMES', menu: ['hangman', 'hangman <letter>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      const g = live(hangGames, ctx.jid);
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        hangGames.delete(ctx.jid);
        return ctx.reply(`It was "${g.word}".`);
      }
      if (!a) {
        if (g) return ctx.reply(`${hangView(g)}\nGuess with ${P()}hangman <letter>`);
        const ng = { word: pick(WORDS), guessed: new Set(), wrong: 0, wrongLetters: [], at: Date.now() };
        hangGames.set(ctx.jid, ng);
        return ctx.reply(`${hangView(ng)}\nGuess with ${P()}hangman <letter> (or the whole word)`);
      }
      if (!/^[a-z]+$/.test(a)) return ctx.reply('Letters only.');
      if (!g) return ctx.reply(`No game running. Start one with ${P()}hangman`);
      g.at = Date.now();
      if (a.length > 1) {
        if (a === g.word) { hangGames.delete(ctx.jid); win(ctx); return ctx.reply(`"${g.word}". Yes. Got it in one.`); }
        g.wrong += 1;
      } else {
        if (g.guessed.has(a) || g.wrongLetters.includes(a)) return ctx.reply('Already tried that one.');
        if (g.word.includes(a)) g.guessed.add(a); else { g.wrong += 1; g.wrongLetters.push(a); }
      }
      if ([...g.word].every((c) => g.guessed.has(c))) { hangGames.delete(ctx.jid); win(ctx); return ctx.reply(`"${g.word}". Solved. Fine.`); }
      if (g.wrong >= HANG_MAX) { hangGames.delete(ctx.jid); return ctx.reply(`Dead. It was "${g.word}".`); }
      return ctx.reply(hangView(g));
    },
  },
  {
    name: 'top', aliases: ['leaderboard', 'gamescore'], category: 'GAMES', menu: ['top'],
    run: (ctx) => {
      const t = topWins(10);
      if (!t.length) return ctx.reply('Nobody has won anything yet.');
      return ctx.reply(`*Game wins*\n${t.map((w, i) => `${i + 1}. ${w.name || w.num}: ${w.n}`).join('\n')}`);
    },
  },

  // UTILITY
  {
    name: 'afk', category: 'UTILITY', menu: ['afk [reason]'],
    run: (ctx) => {
      const reason = (ctx.argText || 'No reason given').slice(0, 120);
      S.setAfk(ctx.senderNum, { reason, since: Date.now(), name: ctx.pushName || '' });
      return ctx.reply(`Fine. You're AFK: ${reason}\nI'll tell anyone who tags you. Send any message when you're back.`);
    },
  },

  // OWNER
  {
    // .d 5s (reply to a message): deletes it after the time. Lumi's own messages always work;
    // other people's only in groups where Lumi is admin. Timers are lost on restart.
    name: 'd', category: 'OWNER', menu: ['d <time>'], ownerOnly: true,
    run: async (ctx) => {
      const ms = parseDuration(ctx.args[0]);
      const q = ctx.ctxInfo;
      if (!ms || !q?.stanzaId) return ctx.reply(`Reply to a message and give a time.\nExample: ${S.prefix()}d 5s  (1s to 6h)`);
      const mine = sentIds.has(q.stanzaId) || Boolean(q.participant && botNumbers(ctx.sock).includes(numberOf(q.participant)));
      const key = { remoteJid: ctx.jid, id: q.stanzaId, fromMe: mine, ...(mine || !q.participant ? {} : { participant: q.participant }) };
      await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏱️', key: ctx.msg.key } }).catch(() => {});
      const t = setTimeout(async () => {
        await ctx.sock.sendMessage(ctx.jid, { delete: key }).catch(() => {});
        await ctx.sock.sendMessage(ctx.jid, { delete: ctx.msg.key }).catch(() => {});
      }, ms);
      if (t.unref) t.unref();
    },
  },
  { name: 'sleep', category: 'OWNER', menu: ['sleep'], ownerOnly: true, run: async (ctx) => { S.setSleep(ctx.jid, true); await ctx.reply(SLEEP_LINE); } },
  { name: 'wake', category: 'OWNER', menu: ['wake'], ownerOnly: true, run: (ctx) => ctx.reply("I'm awake. Unfortunately.") },
  {
    // Hidden. Usage: .claim <passphrase>  (private chat only). Stores your phone number AND hidden id (LID).
    name: 'claim', category: 'OWNER', hidden: true,
    run: async (ctx) => {
      if (!CONFIG.claimPassphrase) return ctx.reply('Claiming is switched off.');
      if (ctx.isGroup) return ctx.reply('Not here. Message me privately. And change that passphrase now; everyone just saw it.');
      if (tooManyAttempts(ctx.senderNum)) return ctx.reply('Too many tries. Come back later.');
      const ok = ctx.argText && crypto.timingSafeEqual(sha(ctx.argText), sha(CONFIG.claimPassphrase));
      if (!ok) { claimAttempts.get(ctx.senderNum).n += 1; return ctx.reply('No.'); }
      S.addClaimed(senderIds(ctx.msg));
      return ctx.reply(`Okay. You're ${CONFIG.ownerName}. I'll remember.`);
    },
  },
  {
    name: 'unclaim', category: 'OWNER', hidden: true, mainOwnerOnly: true,
    run: (ctx) => { S.clearClaimed(); return ctx.reply('Cleared every claimed owner. Only the ids in my settings remain.'); },
  },
  {
    name: 'addsubowner', category: 'OWNER', menu: ['addsubowner @user'], mainOwnerOnly: true,
    run: (ctx) => {
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}addsubowner @user`);
      if (t.every(S.isMainOwner)) return ctx.reply("That one's already the owner.");
      return ctx.reply(S.addSubOwners(t) ? "Done. They can use owner commands now. Don't make me regret it." : 'They already have that.');
    },
  },
  {
    name: 'delsubowner', category: 'OWNER', menu: ['delsubowner @user'], mainOwnerOnly: true,
    run: (ctx) => {
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}delsubowner @user`);
      return ctx.reply(S.removeSubOwners(t) ? 'Removed. Back to normal person.' : "They weren't a sub-owner.");
    },
  },
  {
    name: 'setprefix', category: 'OWNER', menu: ['setprefix <symbol>'], ownerOnly: true,
    run: (ctx) => {
      const cur = S.prefix(), p = ctx.args[0];
      if (!p) return ctx.reply(`Current prefix: ${cur}\nUse: ${cur}setprefix ! (or "reset")`);
      if (p.toLowerCase() === 'reset') { S.setPrefix(null); return ctx.reply(`Prefix reset to ${S.prefix()}`); }
      if (p.length > 2 || /[a-z0-9\s]/i.test(p)) return ctx.reply('Use 1 or 2 symbols, like ! # $ or .');
      S.setPrefix(p);
      return ctx.reply(`Prefix is now ${p}\nExample: ${p}menu`);
    },
  },
  {
    name: 'setprofilepic', category: 'OWNER', menu: ['setprofilepic'], ownerOnly: true,
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['image']);
      if (!media) return ctx.reply('Reply to an image with this command, or send an image with it as the caption.');
      if (Number(media.node.fileLength) > 10 * 1024 * 1024) return ctx.reply('That image is too big (10 MB max).');
      await ctx.sock.updateProfilePicture(jidNormalizedUser(ctx.sock.user.id), await downloadMedia(ctx.sock, media.source));
      return ctx.reply('Done. New face.');
    },
  },
  { name: 'vv', aliases: ['damn', 'viewonce', 'reveal', 'vo'], category: 'OWNER', menu: ['vv'], ownerOnly: true, run: (ctx) => revealViewOnce(ctx, false) },
  { name: 'vv2', aliases: ['cute'], category: 'OWNER', menu: ['vv2'], ownerOnly: true, run: (ctx) => revealViewOnce(ctx, true) },
  {
    name: 'resetaffinity', aliases: ['affinityreset', 'affinityres'], category: 'OWNER', menu: ['resetaffinity @user', 'resetaffinity all'], ownerOnly: true,
    run: (ctx) => {
      if ((ctx.args[0] || '').toLowerCase() === 'all') {
        if (!ctx.isMainOwner) return ctx.reply('Only the main owner can wipe everyone.');
        const c = resetAllAffinity();
        return ctx.reply(`Done. ${c} ${c === 1 ? 'person is' : 'people are'} back to stranger.`);
      }
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}resetaffinity @user\nEveryone: ${S.prefix()}resetaffinity all`);
      return ctx.reply(resetAffinity(t) ? 'Done. Back to stranger.' : 'They had nothing to reset.');
    },
  },
];

const RECAP_TZ = process.env.RECAP_TZ || 'Africa/Lagos';
const recapTime = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: RECAP_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
const recapStamp = (ts) => `${new Intl.DateTimeFormat('en-GB', { timeZone: RECAP_TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(ts)} ${recapTime(ts)}`;
const recapAgo = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${Math.max(1, m)}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
function recapTzOffset(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: RECAP_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ts).map((x) => [x.type, parseInt(x.value, 10)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
function recapDayStart(ts) { const off = recapTzOffset(ts); const l = new Date(ts + off); return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - off; }
function recapRange(token) {
  const t = String(token || '').toLowerCase(); let m;
  if ((m = t.match(/^(\d+)\s*(m|min|h|hr|d|day|days)$/))) { const n = parseInt(m[1], 10); const u = m[2][0]; return { since: Date.now() - n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000), label: `last ${n}${u === 'm' ? ' min' : u === 'h' ? 'h' : 'd'}` }; }
  if (/^\d+$/.test(t)) return { count: Math.min(800, Math.max(10, parseInt(t, 10))), label: null };
  if (t === 'today') return { since: recapDayStart(Date.now()), label: 'today' };
  if (t === 'yesterday') return { since: recapDayStart(recapDayStart(Date.now()) - 3600000), until: recapDayStart(Date.now()), label: 'yesterday' };
  if (t === 'all' || t === 'everything') return { since: 0, label: 'everything I saw' };
  return null;
}
async function recapSubject(sock, jid) {
  const n = ((store.chatlog ||= { chats: {}, names: {} }).names ||= {});
  if (n[jid] && Date.now() - n[jid].at < 6 * 3600000) return n[jid].subject;
  try { const meta = await sock.groupMetadata(jid); if (meta && meta.subject) { n[jid] = { subject: meta.subject, at: Date.now() }; clSchedule(); return meta.subject; } } catch (_) { /* cached */ }
  return (n[jid] && n[jid].subject) || 'a group';
}
function recapStats(rows) {
  const by = new Map(); const kinds = { photo: 0, video: 0, sticker: 0, 'voice note': 0 };
  for (const r of rows) { by.set(r.name, (by.get(r.name) || 0) + 1); const k = (r.text.match(/^\[(photo|video|sticker|voice note)\]/) || [])[1]; if (k) kinds[k] += 1; }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(' · ');
  const media = Object.entries(kinds).filter(([, c]) => c).map(([k, c]) => `${c} ${k}${c > 1 ? 's' : ''}`).join(', ');
  return `_${rows.length} messages from ${by.size} ${by.size === 1 ? 'person' : 'people'}. Most active: ${top}.${media ? ` Shared: ${media}.` : ''}_`;
}
const RECAP_FINAL =
  'You write a recap of a WhatsApp group for someone who missed it. Sound like Lumi: dry and short, no fluff.\n' +
  'Format: first a headline line on what the group was about. Then bullet lines that each start with "• " covering what was discussed, who said or decided what, plans and dates, jokes worth knowing, arguments, and open questions. ' +
  'Use as many bullets as the chat needs (4 to 12), most important first. Name people. Plain text, no markdown, no intro, no outro. Only use what is in the chat; never invent details. Under 2200 characters. Write in the language the chat uses.';
const RECAP_PART = 'You take notes on one part of a long WhatsApp group chat. List everything that matters as short lines starting with "• ": topics, who said or decided what, plans and dates, arguments, open questions. Keep names. Max 10 lines. Plain text, no intro. Never invent details.';
async function recapSummarise(rows, title) {
  const lines = rows.map((r) => `[${recapTime(r.ts)}] ${r.name}: ${r.text}`);
  let parts = []; let cur = '';
  for (const l of lines) { if (cur.length + l.length + 1 > 5500 && cur) { parts.push(cur); cur = ''; } cur += (cur ? '\n' : '') + l; }
  if (cur) parts.push(cur);
  let skipped = 0; if (parts.length > 8) { skipped = parts.length - 8; parts = parts.slice(-8); }
  let material;
  if (parts.length === 1) material = parts[0];
  else {
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      const r = await hooks.generate([{ role: 'system', content: RECAP_PART }, { role: 'user', content: `Part ${i + 1} of ${parts.length} of the chat "${title}":\n${parts[i]}` }]);
      if (!r) return null; notes.push(`Part ${i + 1}:\n${String(r.text).trim()}`);
    }
    material = notes.join('\n\n');
  }
  const res = await hooks.generate([{ role: 'system', content: RECAP_FINAL }, { role: 'user', content: `${parts.length > 1 ? `Notes taken part by part from the group "${title}" (oldest first):` : `Chat of the group "${title}" (oldest first):`}\n${material}` }]);
  return res ? { text: String(res.text).trim().slice(0, 2600), skipped } : null;
}
const recapAt = new Map();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const claimAttempts = new Map();
function tooManyAttempts(num) {
  const now = Date.now(), a = claimAttempts.get(num);
  if (!a || now - a.first > 3600000) { claimAttempts.set(num, { n: 0, first: now }); return false; }
  return a.n >= 5;
}

// ---------- registry + menu ----------

const byName = new Map();
for (const cmd of commandList) {
  byName.set(cmd.name, cmd);
  (cmd.aliases || []).forEach((a) => byName.set(a, cmd));
}
const MENU_ORDER = ['GENERAL', 'AI SYSTEM', 'STICKER TOOLS', 'MEDIA', 'DOWNLOAD', 'PROFILE', 'GROUP TOOLS', 'GAMES', 'UTILITY', 'OWNER'];

const EMOJI = {'GENERAL':'🛠','AI SYSTEM':'🧠','STICKER TOOLS':'🎭','MEDIA':'🎧','DOWNLOAD':'📥','PROFILE':'👤','GROUP TOOLS':'👥','GAMES':'🎮','UTILITY':'🧰','OWNER':'👑'};
const PER_LINE = 4;
// Layout: bold section titles with an emoji, command names only (no arguments), 4 per line.
function renderMenu(groups, cats, prefix, status, footer) {
  const out = ['*LUMI* 🤍', `_${status}_`, ''];
  for (const cat of cats) {
    const names = [...new Set(groups.get(cat).map((e) => String(e).trim().split(/\s+/)[0]))].map((n) => `${prefix}${n}`);
    out.push(`*${EMOJI[cat] || '✨'} ${cat}*`);
    for (let i = 0; i < names.length; i += PER_LINE) out.push(names.slice(i, i + PER_LINE).join('  '));
    out.push('');
  }
  out.push(`_${footer}_`);
  return out.join('\n');
}

function buildMenu() {
  const prefix = S.prefix();
  const groups = new Map();
  for (const c of commandList) {
    if (c.hidden) continue;
    if (!groups.has(c.category)) groups.set(c.category, []);
    for (const e of c.menu || [c.name]) groups.get(c.category).push(e);
  }
  const total = commandList.filter((c) => !c.hidden).length;
  const cats = [...MENU_ORDER.filter((c) => groups.has(c)), ...[...groups.keys()].filter((c) => !MENU_ORDER.includes(c))];
  return renderMenu(groups, cats, prefix, `Online · ${label()} · ${total} commands`, CONFIG.personality === 'warm' || !['maki', 'calm'].includes(CONFIG.personality) ? "Pick a command. I'm listening." : 'Choose a command. I suppose.');
}

// ---------- parsing: prefixed commands for everyone, prefix-free for owners ----------

// Recovery commands also answer to the default prefix, so a forgotten custom prefix never locks anyone out.
const RECOVERY = new Set(['setprefix', 'claim', 'wake']);
const hasNumber = (a) => a.some((x) => { const d = x.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; });
const hasTarget = (ctx) => ctx.mentioned.length > 0 || Boolean(ctx.ctxInfo?.participant);
const hasMedia = (ctx, kinds) => Boolean(findMedia(ctx.msg, kinds));
const onOff = (a) => /^(?:on|off)$/i.test(a[0] || '');
// 'exact' = message is just the word; 'rest' = word + free text; functions = needs a real target / number / media.
const NO_PREFIX = {
  menu: 'exact', help: 'exact', ping: 'exact', about: 'exact', status: 'exact', owner: 'exact', clear: 'exact',
  afk: 'rest', play: 'rest',
  chatbot: (a) => onOff(a), protect: (a) => onOff(a),
  setprefix: (a) => a.length === 1 && (a[0].toLowerCase() === 'reset' || /^[^a-z0-9\s]{1,2}$/i.test(a[0])),
  add: (a) => hasNumber(a),
  kick: (a, ctx) => hasTarget(ctx),
  getpp: (a, ctx) => hasTarget(ctx),
  addsubowner: (a, ctx) => hasTarget(ctx) || hasNumber(a),
  delsubowner: (a, ctx) => hasTarget(ctx) || hasNumber(a),
  creategc: (a) => a.length > 0,
  jail: (a, ctx) => hasTarget(ctx),
  unjail: (a, ctx) => hasTarget(ctx) || /^all$/i.test(a[0] || ''),
  jailed: 'exact',
  gcpp: 'exact',
  poll: (a) => a.join(' ').includes('|'),
  gclink: 'rest',
  d: (a, ctx) => /^\d+\s*(?:s|sec|m|min|h|hr)?$/i.test(a[0] || '') && Boolean(ctx.ctxInfo?.stanzaId),
  s: (a, ctx) => hasMedia(ctx, ['image', 'video']),
  take: (a, ctx) => hasMedia(ctx, ['sticker']),
  toimg: (a, ctx) => hasMedia(ctx, ['sticker']),
  setprofilepic: (a, ctx) => hasMedia(ctx, ['image']),
};

function parsePrefixed(text) {
  const custom = S.prefix();
  let body;
  if (text.startsWith(custom)) body = text.slice(custom.length);
  else if (custom !== CONFIG.prefix && text.startsWith(CONFIG.prefix)) body = text.slice(CONFIG.prefix.length);
  else return null;
  const [name, ...args] = body.trim().split(/\s+/);
  const cmd = byName.get((name || '').toLowerCase());
  if (!cmd) return null;
  if (!text.startsWith(custom) && !RECOVERY.has(cmd.name)) return null;
  return { cmd, args };
}
function parseNoPrefix(text, ctx) {
  if (!ctx.isOwner) return null;
  const stripped = text.replace(/^\s*(?:hey\s+)?lumi[\s,:;-]+/i, '');
  const startedWithName = stripped !== text;
  const [word, ...args] = stripped.trim().split(/\s+/);
  const cmd = byName.get((word || '').toLowerCase().replace(/[.,!?]+$/, ''));
  const rule = cmd && NO_PREFIX[cmd.name];
  if (!rule) return null;
  const addressed = !ctx.isGroup || startedWithName || Boolean(ctx.addressed);
  if (rule === 'exact') return args.length === 0 && addressed ? { cmd, args } : null;
  if (rule === 'rest') return (cmd.name !== 'play' || args.length > 0) && addressed ? { cmd, args } : null;
  return rule(args, ctx) ? { cmd, args } : null;
}
const parse = (text, ctx) => parsePrefixed(text) || parseNoPrefix(text, ctx);

// ---------- AFK ----------

const afkNoticeAt = new Map();
async function afkHandling(ctx, isAfkCommand) {
  const mine = S.getAfk(ctx.senderNum);
  if (mine && !isAfkCommand) {
    S.clearAfk(ctx.senderNum);
    await ctx.reply(`Back already? You were gone ${fmtDuration(Date.now() - mine.since)}.`);
  }
  if (!ctx.isGroup) return;
  const targets = uniq([...ctx.mentioned, ctx.ctxInfo?.participant].filter(Boolean).map(numberOf));
  for (const n of targets) {
    const afk = S.getAfk(n);
    if (!afk || n === ctx.senderNum) continue;
    const key = `${ctx.jid}:${n}`;
    if (Date.now() - (afkNoticeAt.get(key) || 0) < 5 * 60 * 1000) continue;
    afkNoticeAt.set(key, Date.now());
    await ctx.reply(`${afk.name || 'They'} is AFK: ${afk.reason} (${fmtDuration(Date.now() - afk.since)} ago).`);
  }
}

// ---------- entry points ----------

const seen = new Map();
function isDuplicate(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  if (seen.size > 2000) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= 1500) break; }
  return false;
}

function buildCtx(sock, msg) {
  const jid = msg.key.remoteJid;
  const m = unwrap(msg.message);
  const ctxInfo = getContext(m);
  const sender = msg.key.participant || jid;
  const ctx = {
    sock, msg, m, jid, sender, ctxInfo,
    senderNum: numberOf(sender),
    text: getText(m).trim(),
    isGroup: jid.endsWith('@g.us'),
    pushName: socialName(numberOf(sender), msg.pushName || ''),
    mentioned: ctxInfo?.mentionedJid || [],
    taggedJids: realTags(ctxInfo, getText(m).trim()),
    reply: (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg }),
  };
  ctx.isOwner = S.isOwner(ctx.senderNum);
  ctx.isMainOwner = S.isMainOwner(ctx.senderNum);
  ctx.addressed = isAddressed(ctx);
  return ctx;
}

// Returns true when Lumi handled the message (command, AFK-only chatter excluded, sleep, Divine protection).
async function handleCommand(sock, msg) {
  trackSent(sock);
  if (!msg || !msg.message || msg.key.fromMe) return false; // Lumi runs on her OWN number
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  if (isDuplicate(msg.key.id)) return false;
  if (isBlockedMsg(msg)) return false; // .block: ignored everywhere
  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > 120) return false; // old backlog after reconnect
  const m = unwrap(msg.message);
  if (!m || m.protocolMessage || m.reactionMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return false;

  learnAliases(msg);
  autoreadSchedule(sock, msg, getText(unwrap(msg.message) || {}).length);
  vaultRemember(sock, msg).catch(() => {}); // keep view-once messages so .vv works later
  const ctx = buildCtx(sock, msg);
  favAutoSave(sock, msg, ctx); // .favauto on: the owner's stickers become favorites
  if (ctx.isGroup && (await jailCheck(ctx))) return true; // jailed: message deleted, nothing else runs
  const parsed = parse(ctx.text, ctx);
  const isAfkCommand = Boolean(parsed && parsed.cmd.name === 'afk');

  if (ctx.isGroup && !parsed) logChat(jid, ctx.pushName || ctx.senderNum, describeMsg(unwrap(msg.message), ctx.text));

  // Sleep: asleep = total silence in this chat, except the owner waking her up.
  const wantsWake = ctx.isOwner && (WAKE_RE.test(ctx.text) || Boolean(parsed && parsed.cmd.name === 'wake'));
  if (S.isAsleep(jid)) {
    if (wantsWake) { S.setSleep(jid, false); await ctx.reply("Yeah, yeah. I'm up."); return true; }
    if (ctx.isOwner && parsed) { // the owner's commands still work without waking her
      const { cmd, args } = parsed; ctx.args = args; ctx.argText = args.join(' ');
      try { if (cmd.mainOwnerOnly && !ctx.isMainOwner) await ctx.reply('Only the main owner can do that.'); else await cmd.run(ctx); } catch (e) { warn(`command ${cmd.name} failed:`, e.message); }
    }
    return true;
  }
  if (ctx.isOwner && SLEEP_RE.test(ctx.text)) { S.setSleep(jid, true); await ctx.reply(SLEEP_LINE); return true; }

  await afkHandling(ctx, isAfkCommand).catch((e) => warn('AFK handling failed:', e.message));

  if (parsed) {
    const { cmd, args } = parsed;
    ctx.args = args;
    ctx.argText = args.join(' ');
    try {
      if (cmd.mainOwnerOnly && !ctx.isMainOwner) await ctx.reply('Only the main owner can do that.');
      else if (cmd.ownerOnly && !ctx.isOwner) await ctx.reply('That one is for the owner only.');
      else await cmd.run(ctx);
    } catch (e) {
      warn(`command ${cmd.name} failed:`, e.message);
      await ctx.reply("That didn't work. Try again in a bit.").catch(() => {});
    }
    return true;
  }

  // Divine protection: react + reply when the protected person is @mentioned in a group.
  const protect = divineCheck(ctx);
  if (protect) {
    if (protect.emoji) await sock.sendMessage(jid, { react: { text: protect.emoji, key: msg.key } }).catch(() => {});
    await humanReply(sock, msg, protect.reply, { startedAt: ctx.receivedAt || Date.now() });
    return true;
  }
  return false;
}

// ---------- human-like replies ----------
// Reads the message (blue ticks), shows "typing..." for a time that depends on the answer's length, then sends.
// Use it for conversation replies (the host's AI answers too: lumi.humanReply(sock, msg, 'text')). Commands stay instant.
//   HUMAN_REPLY=off to disable, HUMAN_SPEED=1.5 slower / 0.5 faster, HUMAN_MAX_MS=9000 longest wait.
const humanOn = () => !/^(0|false|off|no)$/i.test(process.env.HUMAN_REPLY || 'on');
const humanSpeed = () => { const n = parseFloat(process.env.HUMAN_SPEED); return Number.isFinite(n) && n >= 0 ? n : 1; };
const humanRand = (a, b) => a + Math.random() * (b - a);
const humanSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const humanReadMs = (incoming = '') => Math.round((500 + Math.min(String(incoming).length, 200) * 8 + humanRand(0, 900)) * humanSpeed());
const humanTypeMs = (reply = '') => Math.round(Math.min(8000, Math.max(900, String(reply).length * 55 * humanRand(0.8, 1.25))) * humanSpeed());
async function humanReply(sock, msg, text, { startedAt = Date.now(), extra = {} } = {}) {
  const jid = msg.key.remoteJid;
  const send = () => sock.sendMessage(jid, { text, ...extra }, { quoted: msg });
  if (!humanOn()) return send();
  const read = humanReadMs(unwrap(msg.message) ? getText(unwrap(msg.message)) : '');
  const total = Math.min(read + humanTypeMs(text), Math.round((parseInt(process.env.HUMAN_MAX_MS, 10) || 9000) * humanSpeed()) + read);
  await humanSleep(read - (Date.now() - startedAt));
  await sock.readMessages?.([msg.key]).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await humanSleep(Math.max(Math.round(400 * humanSpeed()), total - (Date.now() - startedAt)));
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  return send();
}

// Should the host's AI answer this message? (AI on for the chat + Lumi addressed in groups + has text)
function shouldChat(sock, msg) {
  const ctx = buildCtx(sock, msg);
  return Boolean(ctx.text) && S.isAiOn(ctx.jid) && isAddressed(ctx);
}
const isAiOn = (jid) => S.isAiOn(jid);

module.exports = {
  handleCommand, shouldChat, isAiOn, configure, buildMenu,
  gainAffinity, getAffinity, isOwner: (num) => S.isOwner(digits(num)), ownerName: CONFIG.ownerName,
  isBlockedMsg, personaOf, favMaybeSend, favMoodOf, humanReply, imagineIntent, generateImage, lookAtPicture, parse, winnerOf, isPrivateIp, parseYoutube, pickVideo, // exported for tests
};
