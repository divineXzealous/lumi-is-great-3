// Paired numbers: other people link THEIR WhatsApp number to Lumi, so Lumi's commands work from their account too.
// Each paired number gets its own WhatsApp connection (login saved in AUTH_DIR/paired/<number>, or in Postgres).
// The person types commands from their own phone (their own messages count as the owner of THAT account);
// everyone else who messages them can use the normal prefixed commands. Lumi only chats with the AI there
// when called by name. Nothing from the main owner's powers carries over to a paired account.
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const config = require('./config');
const log = require('./logger');
const db = require('./db');
const { createStore } = require('./jsonStore');

const store = createStore('paired', { open: false, list: {} });
const live = new Map();            // number -> { sock, stopped, retries, opened }
let handler = null;
let factory = null;                // tests replace this with a fake socket factory

const MAX_PAIRED = () => parseInt(process.env.MAX_PAIRED, 10) || 5;
const PAIR_TIMEOUT_MS = () => parseInt(process.env.PAIR_TIMEOUT_MS, 10) || 180000; // give up if not linked in 3 min
const cleanNumber = (v) => String(v || '').replace(/\D/g, '');
const validNumber = (n) => /^\d{8,15}$/.test(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- login storage ----------
async function authFor(number) {
  const baileys = require('@whiskeysockets/baileys');
  if (db.enabled()) {
    const prefix = `auth:p${number}:`;
    const { usePgAuthState } = require('./pgAuthState');
    const { state, saveCreds } = await usePgAuthState(prefix);
    state.keys = baileys.makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }));
    return { state, saveCreds, wipe: () => db.delPrefix(prefix).catch(() => {}) };
  }
  const dir = path.join(config.authDir, 'paired', number);
  const { state, saveCreds } = await baileys.useMultiFileAuthState(dir);
  return { state, saveCreds, wipe: async () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* gone */ } } };
}

async function makeSock(auth) {
  if (factory) return factory(auth);
  const baileys = require('@whiskeysockets/baileys');
  const { version } = await baileys.fetchLatestBaileysVersion();
  return baileys.default({
    version, auth: auth.state, logger: pino({ level: 'silent' }), printQRInTerminal: false,
    browser: baileys.Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false,
  });
}

// ---------- one connection ----------
// ctl: { wantCode, onCode(code), onOpen(sock), onFail(reason) }
async function connect(number, ctl = {}) {
  const baileys = require('@whiskeysockets/baileys');
  const DR = baileys.DisconnectReason || {};
  const auth = await authFor(number);
  const sock = await makeSock(auth);
  sock.paired = { number };
  const entry = live.get(number) || { retries: 0, opened: false };
  entry.sock = sock; entry.stopped = false; entry.wipe = auth.wipe;
  live.set(number, entry);

  sock.ev.on('creds.update', auth.saveCreds);
  let asked = false; let timer = null; let failed = false;
  const fail = async (reason) => {
    if (failed) return; failed = true;
    clearTimeout(timer);
    entry.stopped = true;
    try { sock.end?.(new Error('pairing failed')); } catch (_) { /* closing */ }
    await auth.wipe(); live.delete(number); delete store.data.list[number]; store.save();
    if (ctl.onFail) ctl.onFail(reason);
  };

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !sock.authState.creds.registered && !asked) {
      asked = true;
      if (!ctl.wantCode) return fail('not linked'); // an unfinished pairing found after a restart: drop it
      try {
        const code = await sock.requestPairingCode(number);
        timer = setTimeout(() => fail('timeout'), PAIR_TIMEOUT_MS());
        if (timer.unref) timer.unref();
        if (ctl.onCode) ctl.onCode(String(code).replace(/(.{4})(.+)/, '$1-$2'));
      } catch (e) { log.warn(`pairing code for ${number} failed: ${e.message}`); fail('no code'); }
    }
    if (connection === 'open') {
      clearTimeout(timer);
      entry.retries = 0; entry.opened = true;
      const rec = store.data.list[number]; if (rec) { rec.status = 'open'; store.save(); }
      log.info(`Paired number ${number} is online.`);
      if (ctl.onOpen) { const f = ctl.onOpen; ctl.onOpen = null; Promise.resolve(f(sock)).catch(() => {}); }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (entry.stopped || failed) return;
      if (code === DR.loggedOut) { // they removed Lumi from Linked Devices
        log.warn(`Paired number ${number} logged out; removing it.`);
        await auth.wipe(); live.delete(number); delete store.data.list[number]; store.save();
        return;
      }
      if (code === DR.connectionReplaced) { log.warn(`Paired number ${number}: connection replaced.`); entry.stopped = true; return; }
      const delay = code === DR.restartRequired ? 500 : Math.min(30000, 2000 * 2 ** Math.min(entry.retries++, 4));
      clearTimeout(timer);
      setTimeout(() => { if (!entry.stopped) connect(number, { ...ctl, wantCode: false }).catch((e) => log.error(`Reconnect ${number} failed: ${e.message}`)); }, delay).unref?.();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Their own typed commands arrive as fromMe (sometimes tagged 'append'); anything else only as 'notify'.
      if (type !== 'notify' && !(type === 'append' && msg.key.fromMe)) continue;
      try { if (handler) await handler(sock, msg); } catch (e) { log.error(`Paired ${number} handler error: ${e.message}`); }
    }
  });
  return sock;
}

// ---------- public API ----------
const setHandler = (fn) => { handler = fn; };
const isOpen = () => Boolean(store.data.open);
const setOpen = (v) => { store.data.open = Boolean(v); store.save(); };
const list = () => Object.entries(store.data.list).map(([number, r]) => ({ number, ...r, online: Boolean(live.get(number)?.opened && !live.get(number)?.stopped) }));
const has = (number) => Boolean(store.data.list[cleanNumber(number)]);

// Start pairing. Resolves with the code to type into WhatsApp. onOpen(sock) runs once they have linked.
async function pair(rawNumber, { by = '', onOpen, onFail } = {}) {
  const number = cleanNumber(rawNumber);
  if (!validNumber(number)) throw Object.assign(new Error('bad number'), { reason: 'bad-number' });
  if (store.data.list[number]) throw Object.assign(new Error('already'), { reason: store.data.list[number].status === 'open' ? 'already' : 'pending' });
  if (Object.keys(store.data.list).length >= MAX_PAIRED()) throw Object.assign(new Error('full'), { reason: 'full' });
  store.data.list[number] = { at: Date.now(), by, status: 'pending' }; store.save();
  return new Promise((resolve, reject) => {
    let gotCode = false;
    connect(number, {
      wantCode: true,
      onCode: (code) => { gotCode = true; resolve(code); },
      onOpen,
      onFail: (reason) => { if (!gotCode) reject(Object.assign(new Error(reason), { reason: 'failed' })); else if (onFail) onFail(reason); },
    }).catch(async (e) => {
      log.warn(`pair ${number} failed: ${e.message}`);
      delete store.data.list[number]; store.save(); live.delete(number);
      reject(Object.assign(new Error(e.message), { reason: 'failed' }));
    });
  });
}

// Remove a number: logs Lumi out of their WhatsApp (best effort), deletes the saved login.
async function unpair(rawNumber) {
  const number = cleanNumber(rawNumber);
  if (!store.data.list[number]) return false;
  const entry = live.get(number);
  if (entry) {
    entry.stopped = true;
    try { await entry.sock.logout?.(); } catch (_) { try { entry.sock.end?.(undefined); } catch (__) { /* closing */ } }
    try { await entry.wipe?.(); } catch (_) { /* gone */ }
  } else { try { (await authFor(number)).wipe(); } catch (_) { /* gone */ } }
  live.delete(number); delete store.data.list[number]; store.save();
  return true;
}

// Called once at start-up: bring every saved paired number back online (one every 2 s).
async function resumeAll(gapMs = 2000) {
  for (const number of Object.keys(store.data.list)) {
    if (store.data.list[number].status !== 'open') { delete store.data.list[number]; continue; } // never finished pairing
    connect(number, {}).catch((e) => log.error(`Could not resume ${number}: ${e.message}`));
    if (gapMs) await sleep(gapMs);
  }
  store.save();
}

module.exports = { pair, unpair, list, has, isOpen, setOpen, setHandler, resumeAll, init: () => store.load(), MAX_PAIRED, cleanNumber, validNumber, _setFactory: (f) => { factory = f; }, _live: live };
