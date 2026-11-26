// Pairing: link someone's WhatsApp number to Lumi so they can use her commands from their own account.
//   .pair [number]     get a pairing code (private chat; owner can do any number, others only their own, and only while pairing is open)
//   .unpair [number]   remove a linked number (owner: any; others: their own). From a linked phone, .unpair removes itself.
//   .pairlist          (owner) who is linked, and whether they are online
//   .pairing open|close   (owner) let other people pair their own number, or stop that
const settings = require('./settings');
const sessions = require('./sessions');
const { numberOf } = require('./jid');

const COOLDOWN_MS = 60000;
const lastTry = new Map();

// The sender's real phone number (WhatsApp may show a hidden id instead).
function phoneOf(ctx) {
  const k = ctx.msg.key;
  const jid = [k.participantPn, k.participantAlt, k.remoteJidAlt, ctx.sender, ctx.jid].find((j) => j && j.endsWith('@s.whatsapp.net'));
  return jid ? numberOf(jid) : '';
}
const pretty = (n) => `+${n}`;
const mainOnlyMsg = (ctx) => ctx.reply('Do that from my own number, not from a linked account.');

const WARNING = "Heads up: this is an unofficial link and WhatsApp can restrict accounts that use bots. You can remove me any time with .unpair, or from WhatsApp > Linked devices.";

module.exports = [
  {
    name: 'pair', aliases: ['link', 'pairme'], category: 'PAIRING', menu: ['pair [number]'], mainOnly: true,
    run: async (ctx) => {
      const p = settings.prefix();
      if (ctx.paired) return mainOnlyMsg(ctx);
      const argNum = sessions.cleanNumber(ctx.args[0]);
      const mine = phoneOf(ctx);
      let number;
      if (ctx.isOwner) number = argNum || mine;
      else {
        if (!sessions.isOpen()) return ctx.reply("Pairing is closed right now. Ask my owner to open it.");
        if (ctx.isGroup) return ctx.reply(`Send ${p}pair to me in a private chat, not here.`);
        number = mine || argNum;
        if (argNum && mine && argNum !== mine) return ctx.reply('You can only pair your own number.');
      }
      if (!number) return ctx.reply(`Tell me the number with country code, no plus.\nExample: ${p}pair 2348012345678`);
      if (!sessions.validNumber(number)) return ctx.reply(`That number doesn't look right. Use digits with the country code, like 2348012345678.`);
      if (!ctx.isOwner && Date.now() - (lastTry.get(ctx.senderNum) || 0) < COOLDOWN_MS) return ctx.reply('Easy. Wait a minute before asking for another code.');
      lastTry.set(ctx.senderNum, Date.now());

      await ctx.reply('One second, getting your code...');
      let code;
      try {
        code = await sessions.pair(number, {
          by: ctx.senderNum,
          onOpen: async (sock) => {
            await ctx.sock.sendMessage(ctx.jid, { text: `Linked! ${pretty(number)} can use me now. Send ${p}menu from any chat on that number.` }).catch(() => {});
            await sock.sendMessage(`${number}@s.whatsapp.net`, { text: `Lumi is linked to this number.\nType commands from any chat, for example ${p}menu. Others who message you can use my commands too, and I only chat when someone calls my name.\nTo remove me: ${p}unpair\n\n${WARNING}` }).catch(() => {});
          },
          onFail: () => ctx.sock.sendMessage(ctx.jid, { text: `The code for ${pretty(number)} expired before it was used. Send ${p}pair to try again.` }).catch(() => {}),
        });
      } catch (e) {
        const msg = { 'bad-number': "That number doesn't look right.", already: `${pretty(number)} is already linked.`, pending: `${pretty(number)} already has a code waiting. Give it a few minutes, or ${p}unpair it first.`, full: 'All my linking slots are taken right now.' }[e.reason];
        return ctx.reply(msg || "Couldn't get a code from WhatsApp right now. Try again in a bit.");
      }
      await ctx.reply(`Your code for ${pretty(number)}:\n\n*${code}*\n\nOn that phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", then type the code. It expires in about 3 minutes.\n\n${WARNING}`);
    },
  },
  {
    name: 'unpair', aliases: ['unlink'], category: 'PAIRING', menu: ['unpair [number]'],
    run: async (ctx) => {
      const argNum = sessions.cleanNumber(ctx.args[0]);
      let number;
      if (ctx.paired) number = ctx.paired.number;                       // typed on a linked phone: removes itself
      else if (ctx.isOwner) number = argNum || phoneOf(ctx);
      else { number = phoneOf(ctx); if (argNum && argNum !== number) return ctx.reply('You can only remove your own number.'); }
      if (!number || !sessions.has(number)) return ctx.reply("That number isn't linked to me.");
      await ctx.reply(`Okay. Unlinking ${pretty(number)}...`).catch(() => {});
      await sessions.unpair(number);
      if (!ctx.paired) await ctx.reply(`${pretty(number)} is unlinked.`);
    },
  },
  {
    name: 'pairlist', aliases: ['paired'], category: 'PAIRING', menu: ['pairlist', 'pairing open|close'], ownerOnly: true, mainOnly: true,
    run: async (ctx) => {
      if (ctx.paired) return mainOnlyMsg(ctx);
      const rows = sessions.list();
      const head = `Pairing is ${sessions.isOpen() ? 'open to everyone' : 'owner-only'}. Slots: ${rows.length}/${sessions.MAX_PAIRED()}.`;
      if (!rows.length) return ctx.reply(`${head}\nNobody is linked.`);
      return ctx.reply(`${head}\n${rows.map((r) => `• ${pretty(r.number)} - ${r.status === 'pending' ? 'waiting for code' : r.online ? 'online' : 'offline'}`).join('\n')}`);
    },
  },
  {
    name: 'pairing', category: 'PAIRING', menu: [], ownerOnly: true, mainOnly: true,
    run: async (ctx) => {
      if (ctx.paired) return mainOnlyMsg(ctx);
      const a = (ctx.args[0] || '').toLowerCase();
      if (a !== 'open' && a !== 'close') return ctx.reply(`Pairing is ${sessions.isOpen() ? 'open' : 'closed'}. Use ${settings.prefix()}pairing open or ${settings.prefix()}pairing close.`);
      sessions.setOpen(a === 'open');
      return ctx.reply(a === 'open' ? 'Pairing is open. Anyone can link their own number by sending me .pair in private.' : 'Pairing is closed. Only you can link numbers.');
    },
  },
];
