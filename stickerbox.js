// Sticker box: save stickers by name and send them back later.
//   .savesticker <name>   (reply to a sticker)     .stickers      list
//   .getsticker <name>    (alias .gs)              .delsticker <name>
// Files live in DATA_DIR/stickers. On Railway, attach a volume to DATA_DIR or they vanish on redeploy.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const settings = require('./settings');
const { findMedia, download } = require('./helpers');
const { createStore } = require('./jsonStore');

const dir = path.join(config.dataDir, 'stickers');
const store = createStore('stickers', { items: {} });
const MAX_BYTES = 1024 * 1024;   // 1 MB per sticker
const MAX_TOTAL = 200;
const MAX_PER_USER = 30;
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
const fileOf = (name) => path.join(dir, `${name}.webp`);

module.exports = [
  {
    name: 'savesticker', aliases: ['ssave', 'stealsticker', 'addsticker'], category: 'STICKER TOOLS', menu: ['savesticker <name>'],
    run: async (ctx) => {
      const p = settings.prefix();
      const name = clean(ctx.args[0]);
      const media = findMedia(ctx.msg, ['sticker']);
      if (!media) return ctx.reply(`Reply to a sticker with ${p}savesticker <name>.`);
      if (!name) return ctx.reply(`Give it a name. Example: ${p}savesticker laugh`);
      const items = store.data.items;
      const mine = Object.values(items).filter((i) => i.by === ctx.senderNum).length;
      if (items[name]) return ctx.reply(`"${name}" is taken. Pick another name.`);
      if (Object.keys(items).length >= MAX_TOTAL) return ctx.reply('The sticker box is full.');
      if (!ctx.isOwner && mine >= MAX_PER_USER) return ctx.reply(`You already saved ${MAX_PER_USER}. Delete one first.`);
      if ((Number(media.node.fileLength) || 0) > MAX_BYTES) return ctx.reply('That sticker is too big (1 MB max).');
      let buf;
      try { buf = await download(ctx.sock, media.source); } catch (_) { return ctx.reply("Couldn't download that sticker."); }
      if (!buf || !buf.length || buf.length > MAX_BYTES) return ctx.reply("Couldn't save that sticker.");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileOf(name), buf);
      items[name] = { by: ctx.senderNum, at: Date.now(), animated: Boolean(media.node.isAnimated) };
      store.save();
      return ctx.reply(`Saved as "${name}". Send it with ${p}getsticker ${name}`);
    },
  },
  {
    name: 'getsticker', aliases: ['gs', 'sendsticker'], category: 'STICKER TOOLS', menu: ['getsticker <name>'],
    run: async (ctx) => {
      const name = clean(ctx.args[0]);
      if (!name) return ctx.reply(`Which one? ${settings.prefix()}stickers shows the list.`);
      if (!store.data.items[name] || !fs.existsSync(fileOf(name))) return ctx.reply(`No sticker called "${name}".`);
      return ctx.sock.sendMessage(ctx.jid, { sticker: fs.readFileSync(fileOf(name)) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'stickers', aliases: ['stickerlist', 'mystickers'], category: 'STICKER TOOLS', menu: ['stickers'],
    run: async (ctx) => {
      const names = Object.keys(store.data.items).sort();
      if (!names.length) return ctx.reply(`No saved stickers yet. Reply to one with ${settings.prefix()}savesticker <name>.`);
      return ctx.reply(`Saved stickers (${names.length}):\n${names.map((n) => `• ${n}`).join('\n')}\n\nSend one: ${settings.prefix()}getsticker <name>`);
    },
  },
  {
    name: 'delsticker', aliases: ['removesticker', 'unsavesticker'], category: 'STICKER TOOLS', menu: [],
    run: async (ctx) => {
      const name = clean(ctx.args[0]);
      const it = store.data.items[name];
      if (!name || !it) return ctx.reply('No sticker with that name.');
      if (!ctx.isOwner && it.by !== ctx.senderNum) return ctx.reply('Only who saved it (or the owner) can delete it.');
      delete store.data.items[name];
      try { fs.unlinkSync(fileOf(name)); } catch (_) { /* already gone */ }
      store.save();
      return ctx.reply(`Deleted "${name}".`);
    },
  },
];
module.exports.init = () => store.load();
