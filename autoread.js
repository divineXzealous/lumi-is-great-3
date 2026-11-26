// Auto-read: Lumi opens messages like a person, so people see the blue ticks without her having to reply.
// She does not read instantly: after a pause that depends on the message (0.8 - 6 s), and she reads a whole
// run of messages in a chat in one go, the way you open a chat and everything turns blue at once.
//   .autoread on | off | dm | groups     (owner, on Lumi's own number)
//   AUTOREAD_SPEED=1 (1.5 = slower, 0.5 = faster)   HUMAN_REPLY=off also turns the pauses off
// Not done: status updates, channels, her own messages, chats where she is asleep, and linked (paired) numbers.
const settings = require('./settings');
const human = require('./human');

const speed = () => { const n = parseFloat(process.env.AUTOREAD_SPEED); return Number.isFinite(n) && n >= 0 ? n : 1; };
const rand = (a, b) => a + Math.random() * (b - a);
const queues = new Map(); // chat -> { keys: [], timer }

function wants(jid, mode) {
  if (mode === 'off') return false;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false;
  const group = jid.endsWith('@g.us');
  return mode === 'on' || (mode === 'groups' ? group : !group);
}

// Call for every incoming message (not from Lumi herself).
function schedule(sock, msg, textLength = 0) {
  const jid = msg.key.remoteJid;
  if (msg.key.fromMe || !wants(jid, settings.getAutoread())) return false;
  let q = queues.get(jid);
  if (!q) { q = { keys: [], timer: null }; queues.set(jid, q); }
  q.keys.push(msg.key);
  if (q.keys.length > 50) q.keys.shift();
  clearTimeout(q.timer);
  const wait = human.enabled() ? Math.round((800 + Math.min(textLength, 250) * 8 + rand(0, 1800)) * speed()) : 0;
  q.timer = setTimeout(async () => {
    queues.delete(jid);
    if (settings.isAsleep(jid) || !wants(jid, settings.getAutoread())) return;
    try { await sock.readMessages(q.keys); } catch (_) { /* not critical */ }
  }, wait);
  if (q.timer.unref) q.timer.unref();
  return true;
}

module.exports = [
  {
    name: 'autoread', aliases: ['read2', 'seen'], category: 'OWNER', menu: ['autoread on', 'autoread off'], ownerOnly: true, mainOnly: true,
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      if (!['on', 'off', 'dm', 'groups'].includes(a)) {
        const now = settings.getAutoread();
        return ctx.reply(`Auto-read is ${now === 'on' ? 'on (all chats)' : now === 'dm' ? 'on for private chats only' : now === 'groups' ? 'on for groups only' : 'off'}.\nUse ${settings.prefix()}autoread on, off, dm or groups.`);
      }
      settings.setAutoread(a);
      return ctx.reply({ on: "Okay. I'll read messages like a person: a little after they arrive.", off: "Done. I'll stop reading messages on my own.", dm: "Okay. I'll auto-read private chats only.", groups: "Okay. I'll auto-read groups only." }[a]);
    },
  },
];
module.exports.schedule = schedule;
module.exports._queues = queues;
