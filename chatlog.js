// Keeps what happened in each group so .recap can tell you about it, even from a private chat or after a restart.
// Saved to disk (DATA_DIR/chatlog.json, or the database) with: text cut to 240 characters, at most 800 entries per group,
// 40 groups, and only the last RECAP_KEEP_DAYS days (default 7). RECAP_PERSIST=off keeps it in memory only.
// Lumi can only know what she SAW while she was in the group; WhatsApp does not give her the older history.
const { createStore } = require('./jsonStore');

const MAX_PER_CHAT = 800;
const MAX_CHATS = 40;
const TEXT_MAX = 240;
const store = createStore('chatlog', { chats: {}, names: {} });
const keepMs = () => { const d = parseFloat(process.env.RECAP_KEEP_DAYS); return (Number.isFinite(d) && d > 0 ? d : 7) * 86400000; };
const persist = () => !/^(0|false|off|no)$/i.test(process.env.RECAP_PERSIST || 'on');
const chats = () => (store.data.chats ||= {});

let saveTimer = null;
function scheduleSave() {
  if (!persist() || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; store.save(); }, 30000); // not on every message: groups can be busy
  saveTimer.unref && saveTimer.unref();
}

// One short line for any kind of message (text, photo, sticker, voice note, poll...). null = nothing worth keeping.
function describe(m, text = '') {
  const cap = String(text || '').trim();
  const tag = (label) => (cap ? `[${label}] ${cap}` : `[${label}]`);
  if (!m) return cap || null;
  if (m.imageMessage) return tag('photo');
  if (m.videoMessage) return tag(m.videoMessage.gifPlayback ? 'gif' : 'video');
  if (m.stickerMessage) return '[sticker]';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.documentMessage) return `[file] ${m.documentMessage.fileName || ''}${cap ? ' ' + cap : ''}`.trim();
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) { const p = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3; return `[poll] ${p.name || ''}`.trim(); }
  if (m.contactMessage || m.contactsArrayMessage) return '[contact]';
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  return cap || null;
}

function add(jid, { name, text, ts }) {
  if (!text) return;
  const c = chats();
  let l = c[jid];
  if (!l) {
    const keys = Object.keys(c);
    if (keys.length >= MAX_CHATS) { // drop the group that was quiet the longest
      const oldest = keys.sort((a, b) => ((c[a][c[a].length - 1] || [0])[0]) - ((c[b][c[b].length - 1] || [0])[0]))[0];
      delete c[oldest]; delete (store.data.names || {})[oldest];
    }
    l = c[jid] = [];
  }
  l.push([ts || Date.now(), String(name || 'Someone').slice(0, 40), String(text).replace(/\s+/g, ' ').slice(0, TEXT_MAX)]);
  if (l.length > MAX_PER_CHAT) l.splice(0, l.length - MAX_PER_CHAT);
  scheduleSave();
}

const toRow = (r) => ({ ts: r[0], name: r[1], text: r[2] });
const fresh = (jid) => { const cut = Date.now() - keepMs(); return (chats()[jid] || []).filter((r) => r[0] >= cut); };
const last = (jid, n) => fresh(jid).slice(-n).map(toRow);
const since = (jid, ts) => fresh(jid).filter((r) => r[0] >= ts).map(toRow);
const count = (jid) => fresh(jid).length;
const firstAt = (jid) => (fresh(jid)[0] || [null])[0];
const lastAt = (jid) => { const l = fresh(jid); return l.length ? l[l.length - 1][0] : null; };
const clear = (jid) => { delete chats()[jid]; scheduleSave(); };
const jids = () => Object.keys(chats()).filter((j) => fresh(j).length);
const setName = (jid, subject) => { (store.data.names ||= {})[jid] = { subject, at: Date.now() }; scheduleSave(); };
const nameOf = (jid) => ((store.data.names || {})[jid] || {}).subject || null;
const nameAge = (jid) => Date.now() - (((store.data.names || {})[jid] || {}).at || 0);

module.exports = { add, last, since, count, firstAt, lastAt, clear, jids, describe, setName, nameOf, nameAge, init: () => store.load(), _store: store };
