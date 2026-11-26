// Decides what to do with each incoming message:
// learn ids -> AFK -> commands -> Divine protection -> AI chat (if Lumi is addressed)
const config = require('./config');
const log = require('./logger');
const { numberOf } = require('./jid');
const { fmtDuration } = require('./time');
const { isDuplicate } = require('./dedupe');
const { unwrap, getText, getContext } = require('./helpers');
const commands = require('./index');
const divine = require('./divine');
const settings = require('./settings');
const vault = require('./vault');
const memory = require('./memory');
const fallback = require('./fallback');
const { systemPrompt, offlineReply, nameCallReply, cleanReply, isBoilerplate, isDistress, provocation, softenProvocation, isWarm, isHumanQuestion, identityReply, isVendorClaim } = require('./personality');
const annoy = require('./annoy');
const voice = require('./voice');
const clapbacks = require('./clapbacks');
const chatlog = require('./chatlog');
const extras = require('./extras');
const human = require('./human');
const vision = require('./vision');
const autoread = require('./autoread');
const favs = require('./favstickers');
const blocklist = require('./blocklist');
const imagine = require('./imagine');
const { findMedia, download } = require('./helpers');

// How much Lumi tolerates this person (see affinity.js). Added to her instructions.
function bondNote(num, isOwner, mode = null) {
  if (isOwner || isWarm(mode)) return ''; // warm Lumi is already kind to everyone
  const { level } = extras.getAffinity(num);
  if (level === 'stranger' || level === 'tolerated') return `\n- Your bond with this person: ${level}. Do not warm up to them.`;
  return `\n- Your bond with this person: ${level}. You are a little less sharp with them than with strangers, but still you.`;
}

const lastAiAt = new Map();
const afkNoticeAt = new Map();

// Owner phrases that put Lumi to sleep / wake her up in the current chat.
const SLEEP_RE = /^\s*(?:hey\s+)?lumi[\s,:;-]+vanish(?:\s+now)?\s*[.!]*\s*$/i;
const WAKE_RE = /^\s*(?:hey\s+)?lumi[\s,:;-]+assemble\s*[.!]*\s*$/i;

// Ids of messages Lumi herself sent. A reply to one of these is a reply to Lumi,
// whatever id (phone number or hidden LID) WhatsApp shows for her.
const sentIds = new Map();
const extraBotIds = new Set(); // her other ids, learned from those replies
const wrapped = new WeakSet();
function trackSent(sock) {
  if (wrapped.has(sock)) return;
  wrapped.add(sock);
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await original(...args);
    const id = res && res.key && res.key.id;
    if (id) {
      sentIds.set(id, Date.now());
      if (sentIds.size > 1000) for (const k of sentIds.keys()) { sentIds.delete(k); if (sentIds.size <= 800) break; }
    }
    return res;
  };
}

// A plain reply to someone is not a tag of them: if the text has no "@" at all, drop the replied-to person from the mentions.
function realTags(ctxInfo, text) {
  const list = ctxInfo?.mentionedJid || [];
  if (!ctxInfo?.participant || String(text || '').includes('@')) return list;
  const replyTo = numberOf(ctxInfo.participant);
  return list.filter((j) => numberOf(j) !== replyTo);
}

const botNumbers = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf).concat([...extraBotIds]);

// WhatsApp can show the same person as a phone number AND as a hidden id (LID).
// When we see both for a known owner/protected person, remember both.
function learnAliases(msg) {
  const k = msg.key;
  const ids = [k.participant, k.participantAlt, k.participantPn, k.remoteJidAlt, k.remoteJid]
    .filter((j) => j && (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')))
    .map(numberOf);
  const uniq = [...new Set(ids)];
  if (uniq.length < 2) return;
  if (uniq.some((n) => settings.isMainOwner(n))) settings.addClaimed(uniq);
  else if (uniq.some((n) => settings.isSubOwner(n))) settings.addSubOwners(uniq);
  else if (uniq.some((n) => settings.protectedIds().includes(n))) settings.addProtectAlias(uniq);
}

// In groups Lumi only answers when addressed: her name, an @mention, or a reply to her.
function isAddressed(ctx, bots) {
  if (!ctx.isGroup) return true;
  if (/\blumi\b/i.test(ctx.text)) return true;
  const quotedId = ctx.ctxInfo?.stanzaId;
  if (quotedId && sentIds.has(quotedId)) {           // a reply to something Lumi said
    if (ctx.ctxInfo.participant) extraBotIds.add(numberOf(ctx.ctxInfo.participant));
    return true;
  }
  if (ctx.mentioned.some((j) => bots.includes(numberOf(j)))) return true;
  if (ctx.ctxInfo?.participant && bots.includes(numberOf(ctx.ctxInfo.participant))) return true;
  return false;
}

async function afkHandling(ctx, isAfkCommand) {
  // 1) The AFK person is back
  const mine = settings.getAfk(ctx.senderNum);
  if (mine && !isAfkCommand) {
    settings.clearAfk(ctx.senderNum);
    await ctx.reply(`Back already? You were gone ${fmtDuration(Date.now() - mine.since)}.`);
  }
  // 2) Someone tagged / replied to an AFK person (groups only, max once per 5 min per person)
  if (!ctx.isGroup) return;
  const targets = [...new Set([...ctx.mentioned, ctx.ctxInfo?.participant].filter(Boolean).map(numberOf))];
  for (const n of targets) {
    const afk = settings.getAfk(n);
    if (!afk || n === ctx.senderNum) continue;
    const key = `${ctx.jid}:${n}`;
    if (Date.now() - (afkNoticeAt.get(key) || 0) < 5 * 60 * 1000) continue;
    afkNoticeAt.set(key, Date.now());
    await ctx.reply(`${afk.name || 'They'} is AFK: ${afk.reason} (${fmtDuration(Date.now() - afk.since)} ago).`);
  }
}

const lastPicAt = new Map();
// Reacts to a picture/sticker. Returns true if she answered (or deliberately stayed quiet), false to fall back to the text path.
async function replyToPicture(ctx, pic) {
  const { sock, senderNum, text } = ctx;
  const gap = parseInt(process.env.VISION_COOLDOWN_MS, 10); const wait = Number.isFinite(gap) ? gap : 5000;
  if (!ctx.isOwner && Date.now() - (lastPicAt.get(senderNum) || 0) < wait) return true;
  lastPicAt.set(senderNum, Date.now());
  const got = await vision.fetchPicture(ctx);
  if (got.error) return Boolean(!text);
  const what = got.kind === 'sticker' ? 'sticker' : 'picture';
  const history = memory.get(senderNum).filter((h) => !(h.role === 'assistant' && isVendorClaim(h.content)));
  const system = systemPrompt({ isGroup: ctx.isGroup, name: ctx.pushName, isOwner: ctx.isOwner, mode: ctx.persona }) + bondNote(senderNum, ctx.isOwner, ctx.persona)
    + `\n- The person sent you a ${what}${text ? ' with a message' : ''}. Look at it and answer in your own voice, in one or two short sentences. Do not narrate it like a robot unless they ask what it shows. If there is text on it, you may read it.`;
  const recent = history.slice(-4).map((h) => `${h.role === 'assistant' ? 'You' : 'Them'}: ${h.content}`).join('\n');
  const prompt = `${recent ? `Recent chat:\n${recent}\n\n` : ''}${text ? `Their message: ${text}` : `They sent this ${what} with no message.`}`;
  if (!human.enabled()) await sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
  const res = await vision.look(got.buf, got.mime, { system, prompt, maxTokens: config.ai.maxTokens });
  if (!human.enabled()) await sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
  if (!res) return Boolean(!text);
  let answer = cleanReply(res.text);
  if (isBoilerplate(answer) && !isDistress(text || '')) return Boolean(!text);
  memory.add(senderNum, 'user', `[sent a ${what}]${text ? ' ' + text : ''}`);
  memory.add(senderNum, 'assistant', answer);
  extras.gainAffinity(senderNum);
  await ctx.say(answer);
  favs.maybeSend(ctx, text, answer);
  return true;
}

async function handleMessage(sock, msg) {
  trackSent(sock);
  const receivedAt = Date.now();
  // Lumi's own number ignores its own messages. On a PAIRED number the person's own typed messages are
  // their commands (but never Lumi's own replies).
  const paired = sock.paired || null;
  if (!msg.message) return;
  if (msg.key.fromMe && (!paired || sentIds.has(msg.key.id))) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (isDuplicate(msg.key.id)) return;

  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > 120) return; // ignore old backlog after reconnect
  if (blocklist.isBlocked(msg)) return; // .block: ignored everywhere, nothing is read, saved or answered

  const m = unwrap(msg.message);
  if (!m || m.protocolMessage || m.reactionMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return;

  if (!paired) learnAliases(msg);

  // Keep a copy of view-once messages as they arrive, so .vv still works after they are opened.
  if (!paired) autoread.schedule(sock, msg, getText(m).length); // blue ticks, a human moment after it arrived
  if (vault.remember(msg)) vault.cacheMedia(sock, msg).catch(() => {});

  const text = getText(m).trim();
  const isGroup = jid.endsWith('@g.us');
  const sender = msg.key.fromMe && paired ? `${paired.number}@s.whatsapp.net` : (msg.key.participant || jid);
  const senderNum = numberOf(sender);
  const ctxInfo = getContext(m);
  const ctx = {
    sock, msg, m, jid, sender, senderNum, text, isGroup, ctxInfo, receivedAt,
    pushName: require('./social').displayName(senderNum, msg.pushName || ''), // the name they picked with .namechange
    mentioned: ctxInfo?.mentionedJid || [],
    // Real @tags only: WhatsApp can list the person you REPLY to in mentionedJid even though you did not tag them.
    taggedJids: realTags(ctxInfo, text),
    paired,
    isOwner: paired ? (Boolean(msg.key.fromMe) || senderNum === paired.number) : settings.isOwner(senderNum),
    isMainOwner: !paired && settings.isMainOwner(senderNum),
    isLumiMessage: (id, participant) => sentIds.has(id) || Boolean(participant && botNumbers(sock).includes(numberOf(participant))),
    persona: settings.getPersona(jid),
    reply: (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg }),
    say: (t, extra) => human.say(ctx, t, extra),
  };

  // Jailed in this group? Delete the message and stop (nothing else runs for it).
  if (isGroup && (await require('./groupfun').check(ctx))) return;

  ctx.addressed = isAddressed(ctx, botNumbers(sock));
  if (ctx.isOwner && !paired) favs.autoSave(sock, msg, ctx); // .favauto on: the owner's stickers become favorites
  const parsed = commands.parse(text, ctx);
  if (paired && msg.key.fromMe && !parsed) return; // the person chatting with friends from their own phone
  const isAfkCommand = Boolean(parsed && parsed.cmd.name === 'afk');

  // Keep what happens in groups (text and a tag for photos, stickers, voice notes...) so .recap can tell the owner about it.
  if (isGroup && !parsed) {
    const line = chatlog.describe(m, text);
    if (line) chatlog.add((paired ? `p${paired.number}:` : '') + jid, { name: ctx.pushName || senderNum, text: line });
  }

  // Sleep mode: asleep = total silence in this chat (no replies, tags, reactions or commands),
  // except the owner waking her up.
  const wantsWake = ctx.isOwner && (WAKE_RE.test(text) || Boolean(parsed && parsed.cmd.name === 'wake'));
  if (settings.isAsleep(jid)) {
    if (wantsWake) { settings.setSleep(jid, false); await ctx.reply("Yeah, yeah. I'm up."); return; }
    // The owner can still use commands (.menu, .backup, .block ...) without waking her. She stays silent otherwise: no chat, no tags.
    if (ctx.isOwner && parsed) await commands.run(ctx);
    return;
  }
  if (ctx.isOwner && SLEEP_RE.test(text)) {
    settings.setSleep(jid, true);
    await ctx.reply("Fine. I'm out. Wake me with 'lumi assemble' when you need me.");
    return;
  }

  // 0) AFK bookkeeping (never blocks the rest)
  await afkHandling(ctx, isAfkCommand).catch((e) => log.warn('AFK handling failed:', e.message));

  // 1) Commands
  if (parsed && (await commands.run(ctx))) return;

  // 2) Divine protection: react + reply
  const protect = paired ? null : divine.check({ ...ctx, mentioned: ctx.taggedJids });
  if (protect) {
    if (protect.emoji) await sock.sendMessage(jid, { react: { text: protect.emoji, key: msg.key } }).catch(() => {});
    await ctx.reply(protect.reply);
    return;
  }

  // 3) AI conversation
  // On a paired number she only chats when called by name (never auto-replies to the person's friends).
  const aiAddressed = paired && !isGroup ? /^\s*(?:hey\s+)?lumi\b/i.test(text) : isAddressed(ctx, botNumbers(sock));
  // A picture or sticker sent to her (or one she is asked about): she looks at it and answers in her own voice.
  const pic = settings.isAiOn(jid) && aiAddressed && vision.enabled() && !/^(0|false|off|no)$/i.test(process.env.VISION_CHAT || 'on') ? findMedia(msg, ['image', 'sticker']) : null;
  if (pic && !(text && provocation(text) && !ctx.isOwner)) {
    if (await replyToPicture(ctx, pic)) return;
  }
  if (!text || !settings.isAiOn(jid) || !aiAddressed) return;


  // Just her name ("Lumi") -> a quick answer with no AI call.
  if (/^@?\s*lumi[\s!?.,]*$/i.test(text)) { await ctx.say(nameCallReply(ctx.isOwner, ctx.persona)); return; }

  // Being annoying (same message again and again, or a flood): she snaps once, then ignores them for a minute.
  // Owners are never treated this way.
  if (!ctx.isOwner) {
    const a = annoy.check(senderNum, text);
    if (a === 'snap') { await ctx.say(clapbacks.pick('annoyed')); return; }
    if (a === 'quiet') return;
  }

  const last = lastAiAt.get(senderNum) || 0;
  if (Date.now() - last < config.ai.userCooldownMs) return;
  lastAiAt.set(senderNum, Date.now());

  // "Lumi, draw a ..." / "generate a picture of ...": paint it.
  const drawPrompt = imagine.intent(text);
  if (drawPrompt) { await imagine.handle(ctx, drawPrompt); return; }

  // "Who built you?" and "what model are you?" are answered directly: never by the AI.
  const who = identityReply(text, ctx.isOwner, ctx.persona);
  if (who) {
    memory.add(senderNum, 'user', text);
    memory.add(senderNum, 'assistant', who);
    await ctx.say(who);
    return;
  }

  // Sincerely asked if she's human: honest, in her own voice.
  if (isHumanQuestion(text)) { await ctx.say(clapbacks.pick(ctx.isOwner ? 'notHumanOwner' : isWarm(ctx.persona) ? 'notHumanWarm' : 'notHuman')); return; }

  // Provoked (insult, slur, pet name, "you're a bot"): she always hits back. No AI needed.
  // For her owner it goes to the AI instead, with a "tease, don't go cold" note.
  const provoked = provocation(text);
  // Owners are never hit back (the AI gets a stay-kind note). Others: rude if hostile, a calm correction if merely curious.
  if (provoked && !ctx.isOwner) { await ctx.say(clapbacks.pick(softenProvocation(provoked, text, ctx.persona))); return; }

  if (!human.enabled()) await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  else setTimeout(() => human.seen(ctx).catch(() => {}), human.readMs(text)); // blue ticks after she "reads" it
  // Drop any old answers that wrongly named a company as her maker.
  const history = memory.get(senderNum).filter((h) => !(h.role === 'assistant' && isVendorClaim(h.content)));
  const messages = [
    { role: 'system', content: systemPrompt({ isGroup, name: ctx.pushName, isOwner: ctx.isOwner, provocation: provoked, mode: ctx.persona }) + bondNote(senderNum, ctx.isOwner, ctx.persona) },
    ...history,
    { role: 'user', content: text },
  ];
  const result = await fallback.generate(messages);
  if (!human.enabled()) await sock.sendPresenceUpdate('paused', jid).catch(() => {});

  if (!result) {
    log.warn('All AI providers failed for a message.');
    await ctx.say(offlineReply());
    return;
  }
  let answer = cleanReply(result.text);
  // Assistant-style safety boilerplate is replaced by a rude one-liner, unless the person seems to be in real distress.
  if (isBoilerplate(answer) && !isDistress(text)) answer = clapbacks.pick(ctx.isOwner ? 'deflectOwner' : isWarm(ctx.persona) ? 'deflectWarm' : 'deflect');
  memory.add(senderNum, 'user', text);
  memory.add(senderNum, 'assistant', answer);
  extras.gainAffinity(senderNum); // +1 affinity per conversation (max once per 30 s per person)
  // Voice-reply mode (owner switch per chat): short AI answers go out as a voice note; if anything fails, plain text.
  if (settings.isVoiceReply(jid) && answer.length <= voice.MAX_REPLY_CHARS) {
    await sock.sendPresenceUpdate('recording', jid).catch(() => {});
    const sentVoice = await voice.sendVoice(sock, jid, answer, { quoted: msg });
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (sentVoice) return;
  }
  await ctx.say(answer);
  favs.maybeSend(ctx, text, answer); // sometimes follows up with a favorite sticker that fits the mood
}

module.exports = { handleMessage };
