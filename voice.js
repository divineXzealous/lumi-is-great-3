// Voice notes (text -> speech).
//   .voice <text>          Lumi says it as a WhatsApp voice note          (also .tts / .say)
//   .voice fr: bonjour     pick a language: en fr es de pt it hi ar sw ja ko zh ru tr nl id
//   .voice                 (reply to a text message) she reads that message out
//   .voicereply on|off     owner only: her AI answers in this chat come as voice notes too
//   .setvoice <Name>       owner only: change her voice (e.g. .setvoice Achernar); .setvoice alone lists them
// Voice: Gemini text-to-speech when GEMINI_API_KEY is set (calm, cool, relaxed style; voice via VOICE_NAME or
// .setvoice; default Despina). If Gemini fails or has no key she falls back to Google Translate's free voice
// (robotic, but it always works). Needs ffmpeg for the round voice-note bubble; without it she sends plain audio.
// Env (optional): VOICE_PROVIDER=google (skip Gemini), VOICE_MODEL, VOICE_NAME, VOICE_STYLE.
const config = require('./config');
const settings = require('./settings');
const log = require('./logger');
const { toVoiceNote } = require('./ffmpeg');

const LANGS = new Set(['en', 'fr', 'es', 'de', 'pt', 'it', 'hi', 'ar', 'sw', 'ja', 'ko', 'zh', 'ru', 'tr', 'nl', 'id']);
const MAX_CHARS = 500;        // for .voice
const MAX_REPLY_CHARS = 300;  // AI answers longer than this stay as text
const CHUNK = 180;            // the speech service takes ~200 characters per request
const COOLDOWN_MS = 15000;    // per person (owners are exempt)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Make the text pleasant to read out loud: no links, no markdown, no emoji.
function speakable(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_~`#>|]/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Split on sentence ends, then on spaces, so no chunk is longer than `size` and no word is cut.
function chunkText(text, size = CHUNK) {
  const out = [];
  const sentences = text.match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [text];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const s of sentences) {
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

// "fr: bonjour" / "fr bonjour" -> { lang: 'fr', text: 'bonjour' }
function parseArgs(argText) {
  const m = /^([a-z]{2})\s*[:,]?\s+(.+)$/is.exec(argText.trim());
  if (m && LANGS.has(m[1].toLowerCase())) return { lang: m[1].toLowerCase(), text: m[2] };
  return { lang: 'en', text: argText.trim() };
}

async function fetchChunk(text, lang) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://translate.google.com/' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`speech service answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('speech service sent an empty answer');
    return buf;
  } finally { clearTimeout(timer); }
}

// text -> audio buffer. Gemini voice first; if that fails (or has no key) the free Google voice.
async function synthesize(text, lang = 'en') {
  const clean = speakable(text);
  if (!clean) throw new Error('nothing to say');
  if (geminiEnabled()) {
    try { return await geminiSpeak(clean); } catch (e) { log.warn('Gemini voice failed, using the backup voice:', e.message); }
  }
  const parts = [];
  for (const c of chunkText(clean)) parts.push(await fetchChunk(c, lang)); // one by one: gentler on the free service
  return Buffer.concat(parts);
}

// Sends text as a voice note. Returns true if sent; false if anything failed (caller may fall back to text).
async function sendVoice(sock, jid, text, { quoted, lang = 'en' } = {}) {
  try {
    const mp3 = await synthesize(text, lang);
    let content;
    try {
      content = { audio: await toVoiceNote(mp3), mimetype: 'audio/ogg; codecs=opus', ptt: true };
    } catch (e) {
      log.warn('voice note conversion failed, sending plain audio:', e.message);
      content = { audio: mp3, mimetype: mp3.slice(0, 4).toString() === 'RIFF' ? 'audio/wav' : 'audio/mpeg', ptt: false };
    }
    await sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
    return true;
  } catch (e) {
    log.warn('voice note failed:', e.message);
    return false;
  }
}

// ---- Gemini voice -------------------------------------------------------------------------------------
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
// Google's own one-word descriptions. They do NOT say which voices are female: listen and pick.
const VOICE_HINTS = { Despina: 'smooth', Achernar: 'soft', Vindemiatrix: 'gentle', Callirrhoe: 'easy-going', Algieba: 'smooth', Sulafat: 'warm', Aoede: 'breezy', Kore: 'firm', Leda: 'youthful', Schedar: 'even', Umbriel: 'easy-going' };
const DEFAULT_VOICE = 'Despina';
const DEFAULT_STYLE = 'calm, cool and relaxed, soft and unhurried, warm and natural, with a clean dry studio sound and no echo or reverb';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const voiceName = () => settings.getVoiceName() || process.env.VOICE_NAME || DEFAULT_VOICE;
const geminiKey = () => (config.ai && config.ai.gemini && config.ai.gemini.key) || process.env.GEMINI_API_KEY || '';
const geminiEnabled = () => Boolean(geminiKey()) && (process.env.VOICE_PROVIDER || '').toLowerCase() !== 'google';

// Finds the first { type: 'audio', data: <base64> } anywhere in the answer (the docs put it at steps[].content[]).
function findAudio(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (node.type === 'audio' && typeof node.data === 'string' && node.data.length > 100) return node.data;
  for (const v of Object.values(node)) { const f = findAudio(v, depth + 1); if (f) return f; }
  return null;
}

async function geminiSpeak(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.VOICE_MODEL || 'gemini-3.8-flash-tts',
        input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: process.env.VOICE_STYLE || DEFAULT_STYLE }] }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: voiceName() }] },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Gemini voice answered ${res.status}`);
    const b64 = findAudio(await res.json());
    if (!b64) throw new Error('Gemini voice sent no audio');
    return Buffer.from(b64, 'base64'); // WAV, 24 kHz mono: ffmpeg reads it directly
  } finally { clearTimeout(timer); }
}

const lastUse = new Map();

module.exports = [
  {
    name: 'voice', aliases: ['tts', 'say'], category: 'MEDIA', menu: ['voice <text>', 'voice fr: bonjour'],
    run: async (ctx) => {
      const quotedText = ctx.ctxInfo && ctx.ctxInfo.quotedMessage
        ? (ctx.ctxInfo.quotedMessage.conversation || (ctx.ctxInfo.quotedMessage.extendedTextMessage || {}).text || '') : '';
      const { lang, text } = ctx.argText ? parseArgs(ctx.argText) : { lang: 'en', text: quotedText };
      if (!text) return ctx.reply(`Give me something to say.\nExample: ${settings.prefix()}voice good morning everyone\nOr reply to a message with ${settings.prefix()}voice. Languages: ${[...LANGS].join(' ')}`);
      if (text.length > MAX_CHARS) return ctx.reply(`That is too long for a voice note (${MAX_CHARS} characters max).`);
      if (!ctx.isOwner) {
        const wait = COOLDOWN_MS - (Date.now() - (lastUse.get(ctx.senderNum) || 0));
        if (wait > 0) return ctx.reply(`Give me ${Math.ceil(wait / 1000)} seconds.`);
        lastUse.set(ctx.senderNum, Date.now());
        if (lastUse.size > 2000) lastUse.delete(lastUse.keys().next().value);
      }
      await ctx.sock.sendPresenceUpdate('recording', ctx.jid).catch(() => {});
      const ok = await sendVoice(ctx.sock, ctx.jid, text, { quoted: ctx.msg, lang });
      await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
      if (!ok) await ctx.reply("My voice isn't working right now. Try again in a bit.");
    },
  },
  {
    name: 'voicereply', aliases: ['vr'], category: 'OWNER', menu: ['voicereply on', 'voicereply off'], ownerOnly: true,
    run: (ctx) => {
      const arg = (ctx.args[0] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') return ctx.reply(`Voice replies are ${settings.isVoiceReply(ctx.jid) ? 'on' : 'off'} here.\nUse ${settings.prefix()}voicereply on or off.`);
      settings.setVoiceReply(ctx.jid, arg === 'on');
      return ctx.reply(arg === 'on' ? "Okay. I'll answer chat messages with voice notes here. Long answers stay as text." : 'Back to text replies here.');
    },
  },
];
module.exports.push({
  name: 'setvoice', mainOnly: true, category: 'OWNER', menu: ['setvoice <name>'], ownerOnly: true,
  run: async (ctx) => {
    const want = (ctx.args[0] || '').toLowerCase();
    const found = GEMINI_VOICES.find((n) => n.toLowerCase() === want);
    if (!want) {
      const list = GEMINI_VOICES.map((n) => (VOICE_HINTS[n] ? `${n} (${VOICE_HINTS[n]})` : n)).join(', ');
      return ctx.reply(`My voice: ${voiceName()}${geminiEnabled() ? '' : ' (Gemini voice is off: no GEMINI_API_KEY, so the backup voice is used)'}\nChange it: ${settings.prefix()}setvoice <name>\nThen test it with ${settings.prefix()}voice hello there.\n\n${list}`);
    }
    if (!found) return ctx.reply(`I don't know a voice called "${ctx.args[0]}". Send ${settings.prefix()}setvoice to see the list.`);
    settings.setVoiceName(found);
    return ctx.reply(`Voice set to ${found}. Try ${settings.prefix()}voice hello, this is my new voice.`);
  },
});
module.exports.sendVoice = sendVoice; module.exports.chunkText = chunkText; module.exports.parseArgs = parseArgs;
module.exports.speakable = speakable; module.exports.findAudio = findAudio; module.exports.GEMINI_VOICES = GEMINI_VOICES; module.exports.MAX_REPLY_CHARS = MAX_REPLY_CHARS;
