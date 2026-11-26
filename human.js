// Makes Lumi's chat replies feel human: she "reads" the message first (blue ticks), then shows
// "typing..." for a time that depends on how long her answer is, and only then sends it.
// The time her AI already took counts, so a slow AI answer is not delayed twice.
// Commands (.ping, .menu ...) are NOT slowed down; only her conversation replies.
//   HUMAN_REPLY=off   turn it off          HUMAN_SPEED=1.5   slower (0.5 = twice as fast)
//   HUMAN_MAX_MS=9000 longest she will ever wait (not counting AI time)
const enabled = () => !/^(0|false|off|no)$/i.test(process.env.HUMAN_REPLY || 'on');
const speed = () => { const n = parseFloat(process.env.HUMAN_SPEED); return Number.isFinite(n) && n >= 0 ? n : 1; };
const maxMs = () => parseInt(process.env.HUMAN_MAX_MS, 10) || 9000;
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Time to "read" the incoming message: 0.5 - 3 s, a bit longer for longer messages.
const readMs = (incoming = '') => Math.round((500 + Math.min(String(incoming).length, 200) * 8 + rand(0, 900)) * speed());
// Time to "type" the answer: ~55 ms per character with some wobble, between 0.9 and 8 s.
const typeMs = (reply = '') => Math.round(Math.min(8000, Math.max(900, String(reply).length * 55 * rand(0.8, 1.25))) * speed());

// Blue ticks, once per message.
async function seen(ctx) {
  if (ctx.__seen) return;
  ctx.__seen = true;
  await ctx.sock.readMessages?.([ctx.msg.key]).catch(() => {});
}

// Send a text reply like a person would.
async function say(ctx, text, extra = {}) {
  if (!enabled()) return ctx.reply(text, extra);
  const started = ctx.receivedAt || Date.now();
  const read = readMs(ctx.text);
  const type = typeMs(text);
  const total = Math.min(read + type, Math.round(maxMs() * speed()) + read);
  let elapsed = Date.now() - started;
  await sleep(read - elapsed);                                   // reading
  await seen(ctx);
  elapsed = Date.now() - started;
  const typing = Math.max(Math.round(400 * speed()), total - elapsed); // typing (what is left of the budget)
  await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
  await sleep(typing);
  await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
  return ctx.reply(text, extra);
}

module.exports = { say, seen, enabled, readMs, typeMs };
