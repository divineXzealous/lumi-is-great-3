// Picture generation: ".imagine a lion wearing a crown" (aliases .img .draw .gen), or just ask her in chat:
// "Lumi, draw a sunset over Lagos" / "generate a picture of a red car".
// Order: Gemini image model (needs GEMINI_API_KEY + a plan that allows it), then Pollinations (free, no key).
//   IMAGE_PROVIDER=auto|gemini|pollinations     IMAGE_MODEL (default gemini-2.5-flash-image)
//   IMAGE_COOLDOWN_MS (default 20000 per person, owners exempt)
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');
const { request } = require('./http');

const cooldownMs = () => { const n = parseInt(process.env.IMAGE_COOLDOWN_MS, 10); return Number.isFinite(n) ? n : 20000; };
const lastAt = new Map(); const busy = new Set();
const MAX_PROMPT = 400;

// Not drawing sexual content, nudity, or anything involving minors in that way.
const BLOCKED = /\b(nsfw|porn\w*|nude|nudes|naked|hentai|erotic|sexual|sex|topless|lingerie|boobs?|genitals?|loli\w*|shota)\b/i;

// "draw ...", "imagine ...", "generate a picture of ..." -> the prompt, else null. (Called only when she is addressed.)
function intent(text) {
  const t = String(text || '').trim().replace(/^(?:hey\s+)?lumi[\s,:;-]+/i, '').replace(/^(?:please|pls|can you|could you|will you)\s+/i, '');
  let m = /^(?:draw|paint|sketch|imagine)\s+(?:me\s+)?(.{3,})$/is.exec(t);
  if (!m) m = /^(?:generate|create|make|design|show me)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:image|picture|pic|photo|illustration|drawing|artwork|wallpaper|logo|portrait)\s*(?:of|for|showing|with|about)?\s*(.{3,})$/is.exec(t);
  return m ? m[1].trim().replace(/[.!?]+$/, '') : null;
}

const isImage = (b) => Buffer.isBuffer(b) && b.length > 1000 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b.slice(0, 4).toString() === 'RIFF'));

async function viaGemini(prompt) {
  const data = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.IMAGE_MODEL || 'gemini-2.5-flash-image')}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.ai.gemini.key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
    timeoutMs: 60000,
  });
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => (p.inlineData || p.inline_data || {}).data);
  if (!part) throw new Error('no image in answer');
  const buf = Buffer.from((part.inlineData || part.inline_data).data, 'base64');
  if (!isImage(buf)) throw new Error('not an image');
  return buf;
}
async function viaPollinations(prompt) {
  const seed = Math.floor(Math.random() * 1e6);
  const buf = await request(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`, { as: 'buffer', timeoutMs: 90000 });
  if (!isImage(buf)) throw new Error('not an image');
  return buf;
}

// -> { buf, provider } or throws
async function generate(prompt) {
  const which = (process.env.IMAGE_PROVIDER || 'auto').toLowerCase();
  const tried = [];
  if (which !== 'pollinations' && config.ai.gemini.key) {
    try { return { buf: await viaGemini(prompt), provider: 'Gemini' }; } catch (e) { tried.push(`gemini: ${e.message}`); log.warn('Gemini image failed:', e.message); }
  }
  if (which !== 'gemini') {
    try { return { buf: await viaPollinations(prompt), provider: 'Pollinations' }; } catch (e) { tried.push(`pollinations: ${e.message}`); log.warn('Pollinations failed:', e.message); }
  }
  throw new Error(tried.join(' | ') || 'no image service');
}

// Shared by .imagine and the natural-language "draw ..." path.
async function handle(ctx, rawPrompt) {
  const prompt = String(rawPrompt || '').trim();
  if (!prompt) return ctx.reply(`Tell me what to draw.\nExample: ${settings.prefix()}imagine a lion wearing a crown`);
  if (prompt.length > MAX_PROMPT) return ctx.reply(`Keep it under ${MAX_PROMPT} characters.`);
  if (BLOCKED.test(prompt)) return ctx.reply("Not drawing that. Ask me for something else.");
  if (busy.has(ctx.jid)) return ctx.reply('Still painting the last one. Hold on.');
  if (!ctx.isOwner && Date.now() - (lastAt.get(ctx.senderNum) || 0) < cooldownMs()) return ctx.reply('Give me a moment between pictures.');
  lastAt.set(ctx.senderNum, Date.now()); busy.add(ctx.jid);
  try {
    await ctx.sock.sendMessage(ctx.jid, { react: { text: '🎨', key: ctx.msg.key } }).catch(() => {});
    await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
    let out;
    try { out = await generate(prompt); } catch (e) { lastAt.delete(ctx.senderNum); return ctx.reply("I couldn't paint that right now. Try again in a bit."); }
    await ctx.sock.sendMessage(ctx.jid, { image: out.buf, caption: prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt }, { quoted: ctx.msg });
  } finally { busy.delete(ctx.jid); await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {}); }
}

module.exports = [
  {
    name: 'imagine', aliases: ['img', 'draw', 'gen', 'generate', 'createimage'], category: 'AI SYSTEM', menu: ['imagine <description>'],
    run: (ctx) => handle(ctx, ctx.argText),
  },
];
module.exports.intent = intent;
module.exports.handle = handle;
module.exports.generate = generate;
module.exports.BLOCKED = BLOCKED;
