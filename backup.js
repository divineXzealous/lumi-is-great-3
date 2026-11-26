// .backup <passphrase> (main owner, private chat only): sends Lumi's data as ONE file you can keep safe.
//   .backup <passphrase>         every setting/list (JSON stores)
//   .backup full <passphrase>    the same plus the saved and favorite stickers (can be big; max ~12 MB)
// Login/auth files are NEVER included. Anyone holding this file can read your chats' settings, so keep it private.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const settings = require('./settings');
const { stores } = require('./jsonStore');

const MAX_BYTES = 12 * 1024 * 1024;
// The passphrase: set BACKUP_PASSPHRASE on Railway (default DIVINE00). Case matters. Three wrong tries lock it for 10 minutes.
const crypto = require('crypto');
const passphrase = () => process.env.BACKUP_PASSPHRASE || 'DIVINE00';
const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const tries = new Map(); // sender -> { n, until }
function collectStickers(dir, out, base = dir) {
  let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectStickers(p, out, base);
    else if (/\.webp$/i.test(e.name)) out[path.relative(base, p)] = fs.readFileSync(p).toString('base64');
  }
}
function build(full) {
  const data = {};
  for (const [name, s] of stores) data[name] = s.data;
  const bundle = { app: 'lumi', version: 1, at: new Date().toISOString(), stores: data };
  if (full) { bundle.stickers = {}; collectStickers(path.join(config.dataDir, 'stickers'), bundle.stickers); }
  return Buffer.from(JSON.stringify(bundle));
}

module.exports = [
  {
    name: 'backup', aliases: ['exportdata'], category: 'OWNER', menu: ['backup'], mainOwnerOnly: true, mainOnly: true,
    run: async (ctx) => {
      if (ctx.isGroup) return ctx.reply(`Do that in a private chat with me. A backup holds everything: ${settings.prefix()}backup`);
      const t = tries.get(ctx.senderNum) || { n: 0, until: 0 };
      if (t.until > Date.now()) return ctx.reply(`Locked for ${Math.ceil((t.until - Date.now()) / 60000)} more minute(s) after too many wrong tries.`);
      const full = (ctx.args[0] || '').toLowerCase() === 'full';
      const given = (full ? ctx.args.slice(1) : ctx.args).join(' ').trim();
      if (!given) return ctx.reply(`Passphrase needed: ${settings.prefix()}backup <passphrase>   or   ${settings.prefix()}backup full <passphrase>`);
      if (!same(given, passphrase())) {
        t.n += 1; if (t.n >= 3) { t.until = Date.now() + 10 * 60 * 1000; t.n = 0; } tries.set(ctx.senderNum, t);
        return ctx.reply('Wrong passphrase.');
      }
      tries.delete(ctx.senderNum);
      let buf = build(full);
      let note = '';
      if (buf.length > MAX_BYTES) { buf = build(false); note = '\n(Too big with the stickers, so this one has settings only.)'; }
      const day = new Date().toISOString().slice(0, 10);
      await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'application/json', fileName: `lumi-backup-${day}${full && !note ? '-full' : ''}.json`, caption: `Backup, ${Math.round(buf.length / 1024)} KB.${note}\nKeep it private. It has no login files.` }, { quoted: ctx.msg });
    },
  },
];
module.exports.build = build;
