// Message vault (adapted from the messageVault you sent).
// Lumi keeps a short-term copy of view-once messages the moment they arrive, because WhatsApp stops
// serving a view-once file once it has been opened or deleted. .vv then reveals it from this copy.
//  - Memory only: nothing is written to disk, and everything is forgotten on restart.
//  - Entries live 6 hours, at most 600 at a time (oldest dropped first). Media over 12 MB is skipped.
//  - By default ONLY view-once messages are kept. Set VAULT_ALL=true to also keep ordinary messages
//    (text + their raw form, no media bytes) - handy later for an anti-delete feature.
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { download } = require('./helpers');
const log = require('./logger');

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 600;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker' };
const keepAll = () => /^(1|true|yes|on)$/i.test(process.env.VAULT_ALL || '');

const store = new Map(); // "jid|id" -> { entry, raw, mediaBuffer }

// Peels ephemeral / view-once / document-caption wrappers. Returns the inner content.
function unwrap(message) {
  let c = message || {};
  for (let i = 0; i < 6; i++) {
    const nested = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message
      || c.viewOnceMessageV2Extension?.message || c.documentWithCaptionMessage?.message;
    if (!nested) break;
    c = nested;
  }
  return c;
}

// Was this message sent as view-once? (wrapper present, or viewOnce flag on the media)
function isViewOnce(message) {
  let c = message || {};
  for (let i = 0; i < 8; i++) {
    if (c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension) return true;
    const nested = c.ephemeralMessage?.message || c.documentWithCaptionMessage?.message;
    if (!nested) break;
    c = nested;
  }
  return Object.keys(KINDS).some((k) => c[k] && c[k].viewOnce === true);
}

// Compact summary of a message.
function describe(message) {
  const c = unwrap(message);
  const text = c.conversation || c.extendedTextMessage?.text || null;
  const base = { text, caption: null, mimetype: null, fileName: null, ptt: false, type: 'unknown' };
  if (text) return { ...base, type: 'text' };
  for (const [key, type] of Object.entries(KINDS)) {
    const m = c[key];
    if (m) return { ...base, type, caption: m.caption || null, mimetype: m.mimetype || null, fileName: m.fileName || null, ptt: Boolean(m.ptt) };
  }
  return base;
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, r] of store) if (r.entry.timestamp < cutoff) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

// Remember one incoming message. Never throws. Returns the entry, or null if it isn't kept.
function remember(message) {
  try {
    const jid = message?.key?.remoteJid; const id = message?.key?.id;
    if (!jid || !id || !message?.message) return null;
    if (message.message.protocolMessage || message.messageStubType) return null;
    const viewOnce = isViewOnce(message.message);
    if (!viewOnce && !keepAll()) return null;
    const sender = message.key.participant || jid;
    const entry = { id, jid, sender, type: describe(message.message).type, viewOnce, pushName: message.pushName || null, timestamp: Date.now(), ...describe(message.message) };
    store.set(`${jid}|${id}`, { entry, raw: message, mediaBuffer: null });
    prune();
    return entry;
  } catch (_) { return null; }
}

// Download the media of a remembered view-once message right now, while WhatsApp still serves it.
async function cacheMedia(sock, message) {
  try {
    const rec = store.get(`${message?.key?.remoteJid}|${message?.key?.id}`);
    if (!rec || rec.mediaBuffer || !rec.entry.viewOnce) return false;
    const c = unwrap(message.message);
    const key = Object.keys(KINDS).find((k) => c[k]);
    if (!key) return false;
    const declared = Number(c[key].fileLength || 0);
    if (declared > MAX_MEDIA_BYTES) return false;
    let buf;
    try { buf = await download(sock, { key: message.key, message: message.message }); }
    catch (_) {
      const stream = await downloadContentFromMessage(c[key], KINDS[key]);
      const chunks = []; let size = 0;
      for await (const ch of stream) { size += ch.length; if (size > MAX_MEDIA_BYTES) return false; chunks.push(ch); }
      buf = Buffer.concat(chunks);
    }
    if (!buf || buf.length < 100 || buf.length > MAX_MEDIA_BYTES) return false;
    rec.mediaBuffer = buf; rec.entry.mediaSize = buf.length;
    return true;
  } catch (e) { log.warn('vault: could not save media:', e.message); return false; }
}

// { ...entry, mediaBuffer, raw } or null.
function lookup(jid, id) {
  const rec = store.get(`${jid}|${id}`);
  if (!rec || Date.now() - rec.entry.timestamp > TTL_MS) return null;
  return { ...rec.entry, mediaBuffer: rec.mediaBuffer, raw: rec.raw };
}
function stats() {
  prune();
  const all = [...store.values()];
  return { total: all.length, viewOnce: all.filter((r) => r.entry.viewOnce).length, withMedia: all.filter((r) => r.mediaBuffer).length, ttlHours: TTL_MS / 3600000 };
}
const clear = () => store.clear();

module.exports = { remember, cacheMedia, lookup, stats, clear, describe, isViewOnce, unwrap, TTL_MS, MAX_ENTRIES };
