// View-once reveal (owner / sub-owner only)
//   .vv   reply to a view-once image / video / voice note: Lumi resends it as normal media, replying to your command
//   .vv2  same, but the revealed media goes to your DM instead of the chat
//   (.damn = .vv and .cute = .vv2; .viewonce / .reveal / .vo also work)
// Lumi saves a copy of every view-once message the moment it arrives (see vault.js), so .vv still works
// after it has been opened. If she wasn't around when it arrived she tries WhatsApp directly, which often fails.
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const log = require('./logger');
const vault = require('./vault');

const KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document' };

// Peels ephemeral + view-once wrappers off a message. WhatsApp sometimes strips the wrapper when quoting
// and only leaves viewOnce: true on the media, so that counts too.
function findViewOnce(quoted) {
  let m = quoted; let wrapped = false;
  for (let i = 0; i < 6 && m; i++) {
    const vo = m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension;
    if (vo) { wrapped = true; m = vo.message; continue; }
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  if (!m) return null;
  for (const key of Object.keys(KINDS)) {
    const node = m[key];
    if (node && (wrapped || node.viewOnce === true)) return { key, type: KINDS[key], node };
  }
  return null;
}

// contextInfo can sit under any message type: search for it (depth-limited).
function contextInfoOf(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (node.contextInfo) return node.contextInfo;
  for (const v of Object.values(node)) {
    if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) continue;
    const found = contextInfoOf(v, depth + 1);
    if (found) return found;
  }
  return null;
}

async function toBuffer(node, type) {
  const stream = await downloadContentFromMessage(node, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Plain (non view-once) message content, keeping the caption / voice-note flag.
function buildContent({ key, node }, buffer) {
  if (key === 'imageMessage') return { image: buffer, caption: node.caption || '' };
  if (key === 'videoMessage') return { video: buffer, caption: node.caption || '', mimetype: node.mimetype || 'video/mp4' };
  if (key === 'documentMessage') return { document: buffer, mimetype: node.mimetype || 'application/octet-stream', fileName: node.fileName || 'revealed-file' };
  return { audio: buffer, mimetype: node.mimetype || 'audio/ogg; codecs=opus', ptt: node.ptt === true };
}

// Where .vv2 sends to: the private chat itself, or the sender's own number when used in a group.
function dmTarget(ctx) {
  if (!ctx.isGroup) return ctx.jid;
  const k = ctx.msg.key;
  return [k.participantPn, k.participantAlt, ctx.sender].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender;
}

async function reveal(ctx, toDm) {
  try {
    const context = ctx.ctxInfo?.quotedMessage ? ctx.ctxInfo : contextInfoOf(ctx.msg?.message);
    const quoted = context?.quotedMessage;
    if (!quoted) return await ctx.reply('Reply to a view-once message');

    // 1) the copy Lumi saved when it arrived  2) the quoted message itself  3) the raw saved message
    const saved = context.stanzaId ? vault.lookup(ctx.jid, context.stanzaId) : null;
    let found = findViewOnce(quoted) || (saved && findViewOnce(saved.raw?.message));
    if (!found && !(saved && saved.mediaBuffer)) return await ctx.reply('Reply to a view-once message');
    if (!found) found = findViewOnce(saved.raw?.message);

    let buffer = saved && saved.mediaBuffer;
    if (!buffer) {
      try { buffer = await toBuffer(found.node, found.type); }
      catch (e) {
        const raw = saved && findViewOnce(saved.raw?.message);
        if (!raw) throw e;
        buffer = await toBuffer(raw.node, raw.type);
      }
    }
    if (!buffer || !buffer.length) throw new Error('empty download');
    const content = buildContent(found, buffer);

    if (toDm) {
      const dm = dmTarget(ctx);
      await ctx.sock.sendMessage(dm, content);
      if (dm !== ctx.jid) await ctx.sock.sendMessage(ctx.jid, { react: { text: '✅', key: ctx.msg.key } }).catch(() => {});
    } else {
      await ctx.sock.sendMessage(ctx.jid, content, { quoted: ctx.msg });
    }
  } catch (e) {
    log.error('vv failed:', e.message);
    const gone = /404|410|not found|expired|directpath|url|empty/i.test(e.message);
    await ctx.reply(gone ? "I couldn't get it. WhatsApp no longer serves that file and I didn't catch it when it arrived." : "Couldn't reveal that one.").catch(() => {});
  }
}

module.exports = [
  { name: 'vv', aliases: ['damn', 'viewonce', 'reveal', 'vo'], category: 'OWNER', menu: ['vv'], ownerOnly: true, run: (ctx) => reveal(ctx, false) },
  { name: 'vv2', aliases: ['cute'], category: 'OWNER', menu: ['vv2'], ownerOnly: true, run: (ctx) => reveal(ctx, true) },
];
module.exports.findViewOnce = findViewOnce;
module.exports.contextInfoOf = contextInfoOf;
