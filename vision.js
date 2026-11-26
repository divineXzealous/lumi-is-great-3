// Lumi can SEE: pictures and stickers.
//  - .read (alias .see / .ocr): reply to a picture or sticker (or send one with .read as the caption).
//    Add a question if you like: ".read what does it say?" / ".read who is this character?" (describes, reads text out)
//  - In chat she also reacts to a picture or sticker sent to her (private chat, a reply to her, a mention, or her name in the caption).
// Uses Gemini (GEMINI_API_KEY); if that fails, Groq's vision model. DeepSeek cannot see pictures.
//   GROQ_VISION_MODEL (default meta-llama/llama-4-scout-17b-16e-instruct)   VISION_MODEL (default = your Gemini model)
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');
const { request } = require('./http');
const { findMedia, download } = require('./helpers');

const MAX_BYTES = 5 * 1024 * 1024;
const geminiModel = () => process.env.VISION_MODEL || config.ai.gemini.model;
const groqModel = () => process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const enabled = () => Boolean(config.ai.gemini.key || config.ai.groq.key);

// Look at a picture. -> { text, provider } or null.
async function look(buf, mime, { system = '', prompt = 'Describe this picture.', maxTokens = 400 } = {}) {
  const type = /^image\//.test(mime || '') ? mime : 'image/jpeg';
  const b64 = buf.toString('base64');
  if (config.ai.gemini.key) {
    try {
      const data = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.ai.gemini.key },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: type, data: b64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
        }),
        timeoutMs: 30000,
      });
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (text) return { text, provider: 'Gemini' };
    } catch (e) { log.warn('Gemini vision failed:', e.message); }
  }
  if (config.ai.groq.key) {
    try {
      const data = await request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.groq.key}` },
        body: JSON.stringify({
          model: groqModel(), temperature: 0.7, max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } }] },
          ],
        }),
        timeoutMs: 30000,
      });
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (text) return { text, provider: 'Groq' };
    } catch (e) { log.warn('Groq vision failed:', e.message); }
  }
  return null;
}

// Picture or sticker in the message itself, or in the one it replies to. -> { buf, mime, kind } | { error }
async function fetchPicture(ctx) {
  const media = findMedia(ctx.msg, ['image', 'sticker']);
  if (!media) return { error: 'none' };
  if ((Number(media.node.fileLength) || 0) > MAX_BYTES) return { error: 'big' };
  try {
    const buf = await download(ctx.sock, media.source);
    if (!buf || !buf.length || buf.length > MAX_BYTES) return { error: 'big' };
    return { buf, mime: media.node.mimetype || (media.kind === 'sticker' ? 'image/webp' : 'image/jpeg'), kind: media.kind, caption: media.node.caption || '' };
  } catch (_) { return { error: 'download' }; }
}

module.exports = [
  {
    name: 'read', aliases: ['see', 'ocr', 'whatsthis'], category: 'AI SYSTEM', menu: ['read'],
    run: async (ctx) => {
      if (!enabled()) return ctx.reply("I can't see pictures right now: no Gemini or Groq key is set.");
      const pic = await fetchPicture(ctx);
      if (pic.error === 'none') return ctx.reply(`Reply to a picture or sticker with ${settings.prefix()}read, or send one with ${settings.prefix()}read as the caption.\nYou can ask something too: ${settings.prefix()}read what does it say?`);
      if (pic.error === 'big') return ctx.reply('That picture is too big for me (5 MB max).');
      if (pic.error) return ctx.reply("I couldn't download that one.");
      const question = ctx.argText.trim();
      await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
      const res = await look(pic.buf, pic.mime, {
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
module.exports.look = look;
module.exports.fetchPicture = fetchPicture;
module.exports.enabled = enabled;
