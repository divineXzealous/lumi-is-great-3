// Group tools: add, kick, promote, demote, link, revoke, mute, unmute, lock, unlock,
// setname, setdesc, admins, groupinfo.
// Admin commands: group admins (or the owner) only, and Lumi must be a group admin herself
// (WhatsApp's rule, not ours). `admins` and `groupinfo` work for everyone.
// (hidetag / tagall live in hidetag.js.)
const settings = require('./settings');
const { numberOf } = require('./jid');
const { groupInfo } = require('./groupTools');

async function guard(ctx) {
  if (!ctx.isGroup) { await ctx.reply('Groups only.'); return null; }
  const info = await groupInfo(ctx.sock, ctx.jid);
  if (!ctx.isOwner && !info.admins.has(ctx.senderNum)) { await ctx.reply('Admins only.'); return null; }
  if (!info.botIsAdmin) { await ctx.reply("Make me an admin first. I can't do that otherwise."); return null; }
  return info;
}

// Targets: @mentions, else the person whose message was replied to.
const getTargets = (ctx) => [...new Set(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []))];

const ADD_STATUS = {
  200: 'added',
  403: 'their privacy settings block adding them',
  408: 'they left recently and cannot be re-added yet',
  409: 'already in the group',
};

// promote / demote share everything except the action and the wording.
async function updateMembers(ctx, action, done, usage) {
  const info = await guard(ctx);
  if (!info) return;
  const targets = getTargets(ctx);
  if (!targets.length) return ctx.reply(usage);
  if (action === 'demote') {
    const protectedIds = settings.protectedIds();
    const blocked = targets.some((j) => { const n = numberOf(j); return info.botNumbers.includes(n) || settings.isOwner(n) || protectedIds.includes(n); });
    if (blocked) return ctx.reply("Not him. Not me either. Pick someone else.");
  }
  const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, action);
  const failed = (res || []).filter((r) => String(r.status) !== '200');
  return ctx.reply(failed.length ? "Couldn't do it for everyone. WhatsApp said no." : done);
}

// Simple on/off style group setting.
const setting = (name, value, done, usage) => ({
  name, category: 'GROUP TOOLS', menu: [name],
  run: async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.sock.groupSettingUpdate(ctx.jid, value);
    return ctx.reply(done);
  },
});


// ---------- creategc / gclink (owner only) ----------
const MAX_NEW_MEMBERS = 10;
const CREATE_COOLDOWN_MS = 30000;   // WhatsApp bans accounts that spam-create groups: keep it slow
let lastCreateAt = 0;
const inviteUrl = async (sock, jid) => `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`;

// The owner's real phone-number id, even if WhatsApp showed us a hidden id (LID) for this message.
function ownerPhoneJid(ctx) {
  const k = ctx.msg.key;
  return [k.participantPn, k.participantAlt, k.remoteJidAlt, ctx.sender, ctx.jid].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender;
}
function botIsAdminIn(sock, meta) {
  const bots = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf);
  return (meta.participants || []).some((p) => p.admin && [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf).some((n) => bots.includes(n)));
}
const NO_ADMIN = "I'm not an admin there, and WhatsApp only gives links to admins. Make me an admin first.";

const gcCommands = [
  {
    // .creategc Study Group              -> new group with just you in it (you become admin)
    // .creategc Study Group 2348012345678 2349087654321   -> also adds those numbers (up to 10)
    name: 'creategc', aliases: ['newgc', 'creategroup'], category: 'OWNER', menu: ['creategc <name> [numbers]'], ownerOnly: true,
    run: async (ctx) => {
      const nums = ctx.args.filter((a) => /^\+?\d[\d-]*$/.test(a) && a.replace(/\D/g, '').length >= 7 && a.replace(/\D/g, '').length <= 15).map((a) => a.replace(/\D/g, ''));
      const name = ctx.args.filter((a) => !/^\+?\d[\d-]*$/.test(a) || a.replace(/\D/g, '').length < 7 || a.replace(/\D/g, '').length > 15).join(' ').trim();
      if (!name) return ctx.reply(`Give the group a name.\nExample: ${settings.prefix()}creategc Study Group\nTo add people too: ${settings.prefix()}creategc Study Group 2348012345678 2349087654321`);
      if (name.length > 100) return ctx.reply('Group names are 100 characters max.');
      const wait = CREATE_COOLDOWN_MS - (Date.now() - lastCreateAt);
      if (wait > 0) return ctx.reply(`Slow down. WhatsApp bans accounts that create groups too fast. Try again in ${Math.ceil(wait / 1000)} seconds.`);
      const owner = ownerPhoneJid(ctx);
      const botNums = [ctx.sock.user?.id, ctx.sock.user?.lid].filter(Boolean).map(numberOf);
      const members = [...new Set([owner, ...nums.map((n) => `${n}@s.whatsapp.net`), ...ctx.mentioned])].filter((j) => !botNums.includes(numberOf(j)));
      if (members.length > MAX_NEW_MEMBERS + 1) return ctx.reply(`That is too many people at once (${MAX_NEW_MEMBERS} max). Add the rest after.`);
      lastCreateAt = Date.now();
      let created;
      try { created = await ctx.sock.groupCreate(name, members); }
      catch (e) { lastCreateAt = 0; return ctx.reply("WhatsApp wouldn't let me create it. Check the numbers are on WhatsApp, or try again in a bit."); }
      const id = created && created.id;
      if (!id) return ctx.reply("It didn't create properly. Check WhatsApp before trying again.");
      await ctx.sock.groupParticipantsUpdate(id, [owner], 'promote').catch(() => {}); // you become admin too
      let link = '';
      try { link = await inviteUrl(ctx.sock, id); } catch (_) { /* group exists but no link yet */ }
      return ctx.reply(`Created *${name}* with ${members.length} ${members.length === 1 ? 'person' : 'people'}.${link ? `\nLink: ${link}` : "\nI couldn't get the link yet. Send .gclink " + name + ' in a moment.'}\nYou're an admin there.`);
    },
  },
  {
    // .gclink                  in a group: that group's link. In a private chat: lists the groups I'm in.
    // .gclink Study Group      link for any group I'm in, found by name (I must be an admin there)
    name: 'gclink', aliases: ['grouplink', 'getlink'], category: 'OWNER', menu: ['gclink [group name]'], ownerOnly: true,
    run: async (ctx) => {
      const q = ctx.argText.trim().toLowerCase();
      if (!q && ctx.isGroup) {
        try { return await ctx.reply(`Group link:\n${await inviteUrl(ctx.sock, ctx.jid)}`); } catch (_) { return ctx.reply(NO_ADMIN); }
      }
      const all = Object.values(await ctx.sock.groupFetchAllParticipating()).sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
      if (!all.length) return ctx.reply("I'm not in any groups.");
      if (!q) {
        const lines = all.slice(0, 30).map((m, i) => `${i + 1}. ${m.subject}${botIsAdminIn(ctx.sock, m) ? '' : ' (not admin)'}`);
        return ctx.reply(`*My groups*\n${lines.join('\n')}${all.length > 30 ? `\n...and ${all.length - 30} more` : ''}\n\nGet a link: ${settings.prefix()}gclink <group name>`);
      }
      const exact = all.filter((m) => String(m.subject).toLowerCase() === q);
      const hits = exact.length ? exact : all.filter((m) => String(m.subject).toLowerCase().includes(q));
      if (!hits.length) return ctx.reply(`I'm not in a group called "${ctx.argText}". Send ${settings.prefix()}gclink to see the list.`);
      if (hits.length > 1) return ctx.reply(`More than one match. Be more specific:\n${hits.slice(0, 10).map((m) => `• ${m.subject}`).join('\n')}`);
      const target = hits[0];
      if (!botIsAdminIn(ctx.sock, target)) return ctx.reply(`${NO_ADMIN} (${target.subject})`);
      try { return await ctx.reply(`*${target.subject}*\n${await inviteUrl(ctx.sock, target.id)}`); } catch (_) { return ctx.reply(`${NO_ADMIN} (${target.subject})`); }
    },
  },
];

module.exports = [
  {
    name: 'add', category: 'GROUP TOOLS', menu: ['add <number>'],
    run: async (ctx) => {
      const info = await guard(ctx);
      if (!info) return;
      const nums = ctx.args.map((a) => a.replace(/\D/g, '')).filter((n) => n.length >= 7 && n.length <= 15);
      if (!nums.length) return ctx.reply(`Give me a number with country code.\nExample: ${settings.prefix()}add 2348012345678`);
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, nums.map((n) => `${n}@s.whatsapp.net`), 'add');
      const lines = (res || []).map((r) => `${numberOf(r.jid)}: ${ADD_STATUS[r.status] || `failed (${r.status})`}`);
      return ctx.reply(lines.join('\n') || 'Nothing happened.');
    },
  },
  {
    name: 'kick', category: 'GROUP TOOLS', menu: ['kick @user'],
    run: async (ctx) => {
      const info = await guard(ctx);
      if (!info) return;
      const targets = getTargets(ctx);
      if (!targets.length) return ctx.reply(`Tag who to remove, or reply to their message.\nExample: ${settings.prefix()}kick @user`);
      const protectedIds = settings.protectedIds();
      const blocked = targets.filter((j) => {
        const n = numberOf(j);
        return info.botNumbers.includes(n) || settings.isOwner(n) || protectedIds.includes(n);
      });
      if (blocked.length) return ctx.reply("Not him. Not me either. Pick someone else.");
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'remove');
      const failed = (res || []).filter((r) => String(r.status) !== '200');
      return ctx.reply(failed.length ? "Couldn't remove everyone. Admins can't be removed by me." : 'Gone.');
    },
  },
  {
    name: 'promote', category: 'GROUP TOOLS', menu: ['promote @user'],
    run: (ctx) => updateMembers(ctx, 'promote', "Done. They're an admin now. Don't make me regret it.",
      `Tag who to promote, or reply to their message.\nExample: ${settings.prefix()}promote @user`),
  },
  {
    name: 'demote', category: 'GROUP TOOLS', menu: ['demote @user'],
    run: (ctx) => updateMembers(ctx, 'demote', 'Done. Back to normal member.',
      `Tag who to demote, or reply to their message.\nExample: ${settings.prefix()}demote @user`),
  },
  {
    name: 'link', category: 'GROUP TOOLS', menu: ['link'],
    run: async (ctx) => {
      if (!(await guard(ctx))) return;
      const code = await ctx.sock.groupInviteCode(ctx.jid);
      return ctx.reply(`Group link:\nhttps://chat.whatsapp.com/${code}`);
    },
  },
  {
    name: 'revoke', aliases: ['resetlink'], category: 'GROUP TOOLS', menu: ['revoke'],
    run: async (ctx) => {
      if (!(await guard(ctx))) return;
      await ctx.sock.groupRevokeInvite(ctx.jid);
      return ctx.reply(`Old link is dead. ${settings.prefix()}link for the new one.`);
    },
  },
  setting('mute', 'announcement', 'Group muted. Only admins can talk now. Peaceful.'),
  setting('unmute', 'not_announcement', 'Group unmuted. Everyone can talk again. Unfortunately.'),
  setting('lock', 'locked', 'Group info locked. Only admins can edit it.'),
  setting('unlock', 'unlocked', 'Group info unlocked. Everyone can edit it.'),
  {
    name: 'setname', category: 'GROUP TOOLS', menu: ['setname <name>'],
    run: async (ctx) => {
      if (!(await guard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new name.\nExample: ${settings.prefix()}setname Lumi Squad`);
      if (ctx.argText.length > 100) return ctx.reply('Group names are 100 characters max.');
      await ctx.sock.groupUpdateSubject(ctx.jid, ctx.argText);
      return ctx.reply('Name changed.');
    },
  },
  {
    name: 'setdesc', category: 'GROUP TOOLS', menu: ['setdesc <text>'],
    run: async (ctx) => {
      if (!(await guard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new description.\nExample: ${settings.prefix()}setdesc Be nice here`);
      await ctx.sock.groupUpdateDescription(ctx.jid, ctx.argText);
      return ctx.reply('Description changed.');
    },
  },
  {
    name: 'admins', category: 'GROUP TOOLS', menu: ['admins'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const meta = await ctx.sock.groupMetadata(ctx.jid);
      const admins = (meta.participants || []).filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
      if (!admins.length) return ctx.reply('No admins. Anarchy.');
      const lines = admins.map((p) => `┃ ${p.admin === 'superadmin' ? '👑' : '🛡️'} @${numberOf(p.phoneNumber || p.id)}`).join('\n');
      return ctx.sock.sendMessage(ctx.jid, { text: `╭━━━「 ADMINS 」\n${lines}\n╰━━━━━━━━━━━━`, mentions: admins.map((p) => p.phoneNumber || p.id) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'groupinfo', aliases: ['ginfo'], category: 'GROUP TOOLS', menu: ['groupinfo'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const m = await ctx.sock.groupMetadata(ctx.jid);
      const people = m.participants || [];
      const created = m.creation ? new Date(m.creation * 1000).toLocaleDateString() : 'Unknown';
      return ctx.reply(
        `╭━━━「 GROUP INFO 」\n` +
        `┃ Name: ${m.subject}\n` +
        `┃ Members: ${people.length}\n` +
        `┃ Admins: ${people.filter((p) => p.admin).length}\n` +
        `┃ Created: ${created}\n` +
        `┃ Description: ${m.desc || 'None'}\n` +
        `╰━━━━━━━━━━━━`);
    },
  },
  ...gcCommands,
];
