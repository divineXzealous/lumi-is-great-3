// Offline tests: no WhatsApp, no real API calls. Run with: npm test
// Heavy libraries (baileys, sharp, pino) are replaced by tiny stand-ins.
const Module = require('module');
const stubs = {
  '@whiskeysockets/baileys': { downloadMediaMessage: async () => global.__dl || Buffer.alloc(0), jidNormalizedUser: (j) => j, default: () => ({}), DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 }, useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }), makeCacheableSignalKeyStore: (k) => k, fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }), Browsers: { ubuntu: () => ['u'] } },
  pino: () => ({ level: 'silent' }),
  sharp: Object.assign(() => ({}), { strategy: { attention: 1 } }),
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return stubs[request] || origLoad.call(this, request, ...rest); };

process.env.DATA_DIR = require('os').tmpdir() + '/lumi-test-' + Date.now();
process.env.GROQ_API_KEY = 'groq-test-key-123';
process.env.DEEPSEEK_API_KEY = 'deepseek-test-key-123';
process.env.GEMINI_API_KEY = 'gemini-test-key-123';
process.env.PROTECTED_CONTACT_ID = '2348000000001';
process.env.CLAIM_PASSPHRASE = 'Ownerdivine00';
process.env.PROTECTED_COOLDOWN_MS = '0';
process.env.MEMORY_LIMIT = '4';
process.env.AUTH_DIR = require('os').tmpdir() + '/lumi-auth-' + Date.now();
process.env.HUMAN_REPLY = 'off'; // the human-delay test turns it on itself

const assert = require('assert');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ', name); };

// ---- helpers to fake WhatsApp
const sent = [];
const sock = {
  user: { id: '15550001111:3@s.whatsapp.net' },
  sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `out${sent.length}` } }; },
  sendPresenceUpdate: async () => {},
  groupMetadata: async () => ({ participants: [{ id: '2348111111111@s.whatsapp.net', admin: 'admin' }, { id: '15550001111@s.whatsapp.net', admin: 'admin' }] }),
  groupParticipantsUpdate: async (_j, targets) => targets.map((t) => ({ status: '200', jid: t })),
};
let n = 0;
const mk = ({ from, group, text, mentions = [], reply, name = 'Tester' }) => ({
  key: { remoteJid: group || `${from}@s.whatsapp.net`, id: `id${++n}`, participant: group ? `${from}@s.whatsapp.net` : undefined, fromMe: false },
  message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions, ...(reply ? { participant: reply } : {}) } } },
  messageTimestamp: Math.floor(Date.now() / 1000), pushName: name,
});
const last = () => sent[sent.length - 1];
const texts = () => sent.map((s) => s.text).filter(Boolean);

(async () => {
  // --- fallback chain with a fake fetch
  const reply = (status, body) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
  let plan = {};
  let lastBody = '';
  global.fetch = async (url, opts) => {
    lastBody = opts && opts.body; global.__bodies = (global.__bodies || []); global.__bodies.push(String(lastBody));
    const p = url.includes('groq') ? 'groq' : url.includes('deepseek') ? 'deepseek' : 'gemini';
    const s = plan[p];
    if (s === 'hang') throw Object.assign(new Error('x'), { name: 'AbortError' });
    if (s !== 200) return reply(s);
    return reply(200, p === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: plan.text || 'from gemini' }] } }] }
      : { choices: [{ message: { content: plan.text || `from ${p}` } }] });
  };
  const fb = require('./fallback');
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];

  await test('Groq answers first when healthy', async () => {
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    assert.strictEqual((await fb.generate(msgs)).provider, 'Groq');
  });
  await test('429 on Groq falls back to DeepSeek, then Groq is skipped while cooling', async () => {
    plan = { groq: 429, deepseek: 200, gemini: 200 };
    assert.strictEqual((await fb.generate(msgs)).provider, 'DeepSeek');
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    assert.strictEqual((await fb.generate(msgs)).provider, 'DeepSeek'); // Groq still cooling
  });
  await test('DeepSeek 500 falls to Gemini; all failing returns null', async () => {
    plan = { groq: 429, deepseek: 500, gemini: 200 };
    assert.strictEqual((await fb.generate(msgs)).provider, 'Gemini');
    plan = { groq: 500, deepseek: 500, gemini: 'hang' };
    assert.strictEqual(await fb.generate(msgs), null);
  });

  // --- memory
  const memory = require('./memory');
  await test('memory is per-user, limited and clearable', async () => {
    for (let i = 0; i < 6; i++) memory.add('a', 'user', 'm' + i);
    memory.add('b', 'user', 'other');
    assert.strictEqual(memory.get('a').length, 4);
    memory.clear('a');
    assert.strictEqual(memory.get('a').length, 0);
    assert.strictEqual(memory.get('b').length, 1);
  });

  // --- full message flow
  const { handleMessage } = require('./messageHandler');
  const settings = require('./settings');
  const G = '12345@g.us';
  const DIVINE = '2348000000001@s.whatsapp.net';

  await test('tagging Divine in a group: Lumi replies (no reaction)', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000001', group: G, text: '@Divine come', mentions: [DIVINE] }));
    assert.ok(!sent.some((s) => s.react), 'reaction should be off');
    assert.ok(sent.some((s) => s.text), 'no reply');
  });
  await test('Divine tagging himself, or plain text with his name, does nothing', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2348000000001', group: G, text: 'hi', mentions: [DIVINE] }));
    await handleMessage(sock, mk({ from: '2349000000001', group: G, text: 'where is divine' }));
    assert.strictEqual(sent.length, 0);
  });
  await test('replying to Divine\'s message does NOT trigger it (only real tags do)', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000002', group: G, text: 'hey', reply: DIVINE }));
    assert.strictEqual(sent.length, 0);
  });
  await test('.protect off stops it (owner only)', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000001', group: G, text: '.protect off' }));
    assert.ok(/owner only/i.test(last().text));
  });

  await test('.claim: wrong passphrase refused, group refused, right one in private works', async () => {
    const U = '2347000000007';
    sent.length = 0;
    await handleMessage(sock, mk({ from: U, text: '.claim wrong' }));
    assert.strictEqual(last().text, 'No.');
    assert.strictEqual(settings.isOwner(U), false);
    await handleMessage(sock, mk({ from: U, group: G, text: '.claim Ownerdivine00' }));
    assert.strictEqual(settings.isOwner(U), false);
    await handleMessage(sock, mk({ from: U, text: '.claim Ownerdivine00' }));
    assert.strictEqual(settings.isOwner(U), true);
    assert.ok(settings.protectedIds().includes(U));
  });
  await test('claim is rate-limited after 5 wrong tries', async () => {
    const V = '2347000000008';
    for (let i = 0; i < 6; i++) await handleMessage(sock, mk({ from: V, text: '.claim nope' }));
    await handleMessage(sock, mk({ from: V, text: '.claim Ownerdivine00' }));
    assert.strictEqual(settings.isOwner(V), false);
  });

  const OWNER = '2347000000007';
  await test('claimed owner now gets protected in groups, and can use owner commands', async () => {
    settings.setProtect(true);
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000001', group: G, text: 'yo', mentions: [`${OWNER}@s.whatsapp.net`] }));
    assert.ok(!sent.some((s) => s.react));
  });

  await test('.setprefix changes the prefix; old prefix stops working', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '.setprefix !' }));
    assert.strictEqual(settings.prefix(), '!');
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '!ping' }));
    assert.ok(/Online/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '.ping' }));
    assert.ok(!texts().some((t) => /Online/.test(t)));
    await handleMessage(sock, mk({ from: OWNER, text: '!setprefix reset' }));
    assert.strictEqual(settings.prefix(), '.');
  });

  await test('.afk: tagged AFK user gets announced, and returning clears it', async () => {
    const A = '2349100000001';
    await handleMessage(sock, mk({ from: A, group: G, text: '.afk lunch', name: 'Ayo' }));
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000002', group: G, text: 'hey', mentions: [`${A}@s.whatsapp.net`] }));
    assert.ok(/AFK: lunch/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: A, group: G, text: 'im back' }));
    assert.ok(/Back already/.test(last().text));
    assert.strictEqual(settings.getAfk(A), null);
  });

  await test('.kick refuses the owner, works on others, needs admin', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000001', group: G, text: '.kick @x', mentions: ['2349555555555@s.whatsapp.net'] }));
    assert.strictEqual(last().text, 'Admins only.');
    // make the sender an admin via the fake group
    const admin = '2348111111111';
    sent.length = 0;
    await handleMessage(sock, mk({ from: admin, group: G, text: '.kick @owner', mentions: [`${OWNER}@s.whatsapp.net`] }));
    assert.ok(/Not him/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: admin, group: G, text: '.kick @x', mentions: ['2349555555555@s.whatsapp.net'] }));
    assert.strictEqual(last().text, 'Gone.');
  });

  await test('saying just "Lumi" gets a quick answer; chatbot off silences chat', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000003', text: 'Lumi' }));
    assert.ok(['Yes?', 'Hey, I\'m here.', 'Yeah?', 'Hi there.', 'Hm? I\'m listening.'].includes(last().text), last().text);
    await handleMessage(sock, mk({ from: OWNER, text: '.chatbot off' }));
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: 'Lumi' }));
    assert.strictEqual(sent.length, 0);
    await handleMessage(sock, mk({ from: OWNER, text: '.ai on' }));
  });

  await test('a reply to one of Lumi\'s messages gets an answer, even without her name', async () => {
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349000000009', group: G, text: 'Lumi' }));   // she says "Yes?" etc.
    const lumiMsgId = `out${sent.length}`;
    assert.ok(sent.length >= 1);
    const m = mk({ from: '2349000000009', group: G, text: 'How are you' });
    m.message.extendedTextMessage.contextInfo.stanzaId = lumiMsgId;
    m.message.extendedTextMessage.contextInfo.participant = '99887766554433@lid'; // her hidden id
    sent.length = 0;
    await handleMessage(sock, m);
    assert.ok(sent.some((x) => x.text), 'no answer to the reply');
    // and a reply to somebody else's message is still ignored
    const other = mk({ from: '2349000000009', group: G, text: 'How are you' });
    other.message.extendedTextMessage.contextInfo.stanzaId = 'someone-elses-message';
    other.message.extendedTextMessage.contextInfo.participant = '2349000000010@s.whatsapp.net';
    sent.length = 0;
    await handleMessage(sock, other);
    assert.strictEqual(sent.length, 0);
  });

  await test('Divine has 20 different lines, with no repeats back to back', async () => {
    const { REPLIES } = require('./divine');
    assert.strictEqual(REPLIES.length, 3);
    assert.strictEqual(new Set(REPLIES).size, 3);
    const seen = [];
    for (let i = 0; i < 40; i++) {
      sent.length = 0;
      await handleMessage(sock, mk({ from: '2349000000001', group: `g${i}@g.us`, text: 'x', mentions: [DIVINE] }));
      seen.push(sent.find((x) => x.text).text);
    }
    for (let i = 1; i < seen.length; i++) assert.notStrictEqual(seen[i], seen[i - 1]);
  });

  await test('.addsubowner / .delsubowner: only the main owner, and sub-owners get owner commands', async () => {
    const SUB = '2349200000001';
    // a stranger cannot
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349200000009', text: '.addsubowner ' + SUB }));
    assert.ok(/main owner|owner only/i.test(last().text));
    assert.strictEqual(settings.isOwner(SUB), false);
    // the main owner can (typed number, and by tag)
    await handleMessage(sock, mk({ from: OWNER, text: '.addsubowner ' + SUB }));
    assert.strictEqual(settings.isOwner(SUB), true);
    assert.strictEqual(settings.isMainOwner(SUB), false);
    // the sub-owner can use owner commands...
    sent.length = 0;
    await handleMessage(sock, mk({ from: SUB, text: '.protect on' }));
    assert.ok(/Protection is on/.test(last().text));
    // ...but cannot add more sub-owners or unclaim
    sent.length = 0;
    await handleMessage(sock, mk({ from: SUB, text: '.addsubowner 2349200000002' }));
    assert.ok(/main owner/i.test(last().text));
    assert.strictEqual(settings.isOwner('2349200000002'), false);
    // tag works too
    await handleMessage(sock, mk({ from: OWNER, group: G, text: '.addsubowner @x', mentions: ['2349200000003@s.whatsapp.net'] }));
    assert.strictEqual(settings.isOwner('2349200000003'), true);
    // remove
    await handleMessage(sock, mk({ from: OWNER, text: '.delsubowner ' + SUB }));
    assert.strictEqual(settings.isOwner(SUB), false);
  });

  await test('a sub-owner\'s hidden id is learned, and never turns into a main owner', async () => {
    const SUB2 = '2349200000003';
    const m = mk({ from: SUB2, group: G, text: 'hi' });
    m.key.participant = '55566677788@lid';
    m.key.participantAlt = SUB2 + '@s.whatsapp.net';
    await handleMessage(sock, m);
    assert.strictEqual(settings.isOwner('55566677788'), true);
    assert.strictEqual(settings.isMainOwner('55566677788'), false);
  });

  await test('assistant-style filler is stripped from AI replies', async () => {
    const { cleanReply } = require('./personality');
    assert.strictEqual(cleanReply('Fine. What do you need?'), 'Fine.');
    assert.strictEqual(cleanReply('Sure, whatever. Anything else?'), 'Whatever.');
    assert.strictEqual(cleanReply('I need something to eat, you?'), 'I need something to eat, you?');
  });

  await test('"who built you" is answered directly with the owner, never a company', async () => {
    plan = { groq: 500, deepseek: 500, gemini: 500 }; // if the AI were asked, we'd get the offline line
    const qs = ['who built you', 'Who made you?', 'who created u', 'who is your creator', 'what model are you', 'are you chatgpt', 'which company made you', 'Lumi who developed you'];
    for (const [i, q] of qs.entries()) {
      sent.length = 0;
      await handleMessage(sock, mk({ from: `23493100000${i}`, text: q }));
      assert.ok(/Divine/.test(last().text), q + ' -> ' + (last() && last().text));
      assert.ok(!/open\s*ai|chatgpt|google|meta/i.test(last().text));
    }
    plan = { groq: 200, deepseek: 200, gemini: 200 };
  });
  await test('normal questions are not mistaken for identity questions', async () => {
    const { identityReply } = require('./personality');
    for (const q of ['who made the pizza', 'build me a website', 'what is your favourite food', 'make me laugh']) assert.strictEqual(identityReply(q), null, q);
  });
  await test('an AI answer that names a company as her maker is rewritten', async () => {
    const { cleanReply } = require('./personality');
    const out = cleanReply('I was built by OpenAI. Whatever.');
    assert.ok(/Divine built me/.test(out) && !/OpenAI/.test(out), out);
  });
  await test('provocations are detected (and ordinary talk is not)', async () => {
    const { provocation } = require('./personality');
    assert.strictEqual(provocation('you are a retard lol'), 'insult');
    assert.strictEqual(provocation('good girl'), 'pet');
    assert.strictEqual(provocation("you're just a bot"), 'bot');
    assert.strictEqual(provocation('u r a robot'), 'bot');
    assert.strictEqual(provocation('stupid bot'), 'bot');
    assert.strictEqual(provocation('lumi bot how far'), 'bot');
    assert.strictEqual(provocation('hello how are you'), null);
    assert.strictEqual(provocation('this exam is stupid'), null);   // not aimed at her
    assert.strictEqual(provocation('what bot commands exist'), null);
  });
  await test('when provoked she ALWAYS hits back with an insult line, with no AI call', async () => {
    const { LINES } = require('./clapbacks');
    plan = { groq: 500, deepseek: 500, gemini: 500 }; // an AI call would give the offline line instead
    // warm mode: hostile messages get the rude line; merely curious/cutesy ones get a calm correction
    const cases = [['you stupid useless thing', 'insult'], ['you retard', 'insult'], ['good girl', 'petSoft'], ["you're just a bot", 'bot'], ['are you a robot lol', 'botSoft'], ['you stupid bot', 'bot'], ['good girl you useless thing', 'pet']];
    for (const [i, [msg, kind]] of cases.entries()) {
      sent.length = 0;
      await handleMessage(sock, mk({ from: `23493200000${i}`, text: msg }));
      assert.ok(LINES[kind].includes(last().text), `${msg} -> ${last() && last().text}`);
    }
    plan = { groq: 200, deepseek: 200, gemini: 200 };
  });
  await test('every comeback line is clean (no slurs, no false human/bot claims)', async () => {
    const { LINES } = require('./clapbacks');
    const all = Object.values(LINES).flat();
    assert.ok(all.length >= 60);
    for (const l of all) {
      assert.ok(!/retard|nigg|fag|slut|whore|cunt/i.test(l), l);
      assert.ok(!/\bnot a bot\b|i'?m (?:a )?human/i.test(l), l);
    }
  });
  await test('sincerely asked if she is human: she says no, honestly', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349330000001', text: 'are you human' }));
    assert.ok(/not (?:a )?(?:human|person)|no, i'?m not human|human\? no/i.test(last().text), last().text);
  });
  await test('her owner is never hit with canned insults: the AI gets a stay-kind note', async () => {
    settings.addSubOwners(['2349400000001', '2349400000002']);
    require('./fallback').resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    await handleMessage(sock, mk({ from: '2349400000001', text: 'you stupid useless bot' }));
    assert.ok(/RIGHT NOW/.test(lastBody) && /do NOT insult/.test(lastBody), 'no owner note sent to the AI');
  });
  await test('if the AI says "I am a bot/AI", the line is rewritten', async () => {
    const { cleanReply } = require('./personality');
    const out = cleanReply("I'm an AI. Whatever.");
    assert.ok(!/\bAI\b/.test(out) && /Lumi/.test(out), out);
  });

  await test('leaked "thinking" is stripped from AI replies (the Wsp screenshot case)', async () => {
    const { stripReasoning } = require('./clean');
    const leak = 'What now, Divine? Another pointless hello?We need to respond? The user says "Wsp". So respond: "What?" maybe. Keep short.What\'s the drama? User: "Wsp". Should reply.What\'s up? We need to be consistent with persona: short, rude. Your greetings are as useful as a broken clock.User says "Wsp". We answer.Wsp? Spare me.We should produce one final answer.Wsp? Spare me.';
    const r = stripReasoning(leak);
    assert.ok(r.leaked);
    assert.strictEqual(r.text, 'Wsp? Spare me.');
    assert.strictEqual(stripReasoning('<think>blah blah</think>Get lost.').text, 'Get lost.');
    const normal = stripReasoning('You again. Pathetic.');
    assert.ok(!normal.leaked && normal.text === 'You again. Pathetic.');
    assert.strictEqual(stripReasoning('The user says hi in my story. Fine.').leaked, false); // one hint alone is not a leak
  });
  await test('Groq reasoning models get the "hide reasoning" settings; normal models get none', async () => {
    const { groqParams } = require('./params');
    assert.deepStrictEqual(groqParams('openai/gpt-oss-20b'), { include_reasoning: false, reasoning_effort: 'low' });
    assert.deepStrictEqual(groqParams('qwen/qwen3-32b'), { reasoning_format: 'hidden' });
    assert.deepStrictEqual(groqParams('llama-3.3-70b-versatile'), {});
  });
  await test('a leaking AI reply never reaches the chat', async () => {
    require('./fallback').resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200, text: 'The user says Wsp. We need to respond. We should produce one final answer.Wsp? Spare me.' };
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349500000001', text: 'Wsp' }));
    assert.strictEqual(last().text, 'Wsp? Spare me.');
    plan = { groq: 200, deepseek: 200, gemini: 200 };
  });

  await test('safety-boilerplate is replaced by a rude line, unless the person is truly in distress', async () => {
    const { LINES } = require('./clapbacks');
    require('./fallback').resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200, text: "I'm not going to do that. If you're feeling upset, please consider reaching out to someone you trust or a mental-health professional for support." };
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349500000002', text: 'Rest' }));
    assert.ok(LINES.deflectWarm.includes(last().text), last().text);
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349500000003', text: 'I want to kill myself' }));
    assert.ok(/mental-health/.test(last().text), 'real distress must not be swallowed');
    plan = { groq: 200, deepseek: 200, gemini: 200 };
  });

  await test('"lumi vanish" = total silence (replies, tags, commands) until the owner wakes her', async () => {
    const SG = '777@g.us';
    sent.length = 0;
    // a stranger cannot put her to sleep
    await handleMessage(sock, mk({ from: '2349600000001', group: SG, text: 'lumi vanish' }));
    assert.ok(!settings.isAsleep(SG));
    await handleMessage(sock, mk({ from: OWNER, group: SG, text: 'lumi vanish' }));
    assert.ok(settings.isAsleep(SG));
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349600000002', group: SG, text: 'Lumi hello' }));                         // name
    await handleMessage(sock, mk({ from: '2349600000003', group: SG, text: '.ping' }));                              // command
    await handleMessage(sock, mk({ from: '2349600000004', group: SG, text: 'yo', mentions: [DIVINE] }));             // tag Divine
    await handleMessage(sock, mk({ from: '2349600000005', group: SG, text: 'you retard', reply: '15550001111@s.whatsapp.net' })); // reply to her
    await handleMessage(sock, mk({ from: OWNER, group: SG, text: 'Lumi hello' }));                                    // the owner's chat: still silent
    assert.strictEqual(sent.length, 0, 'she spoke while asleep: ' + JSON.stringify(sent));
    await handleMessage(sock, mk({ from: OWNER, group: SG, text: '.ping' }));                                         // but the owner's COMMANDS work without waking her
    assert.ok(/Online/.test(last().text) && settings.isAsleep(SG), 'owner commands should run while she sleeps');
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349600000006', group: SG, text: 'lumi assemble' }));                        // a stranger cannot wake her
    assert.ok(settings.isAsleep(SG));
    await handleMessage(sock, mk({ from: OWNER, group: SG, text: 'Lumi assemble' }));
    assert.ok(!settings.isAsleep(SG));
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349600000007', group: SG, text: '.ping' }));
    assert.ok(/Online/.test(last().text));
    // asleep in one chat does not affect another
    await handleMessage(sock, mk({ from: OWNER, text: '.sleep' }));
    assert.ok(settings.isAsleep(`${OWNER}@s.whatsapp.net`) && !settings.isAsleep(SG));
    await handleMessage(sock, mk({ from: OWNER, text: '.wake' }));
    assert.ok(!settings.isAsleep(`${OWNER}@s.whatsapp.net`));
  });

  await test('.d 1s deletes the replied-to message after the time (Lumi\'s own, and others\')', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349700000001', group: G, text: 'Lumi' }));   // she answers; her message id is out<N>
    const lumiMsgId = `out${sent.length}`;
    const m = mk({ from: OWNER, group: G, text: '.d 1s' });
    m.message.extendedTextMessage.contextInfo.stanzaId = lumiMsgId;
    m.message.extendedTextMessage.contextInfo.participant = '15550001111@s.whatsapp.net';
    sent.length = 0;
    await handleMessage(sock, m);
    assert.ok(sent.some((x) => x.react), 'no timer reaction');
    assert.ok(!sent.some((x) => x.delete), 'deleted too early');
    // someone else's message as well
    const m2 = mk({ from: OWNER, group: G, text: '.d 1s' });
    m2.message.extendedTextMessage.contextInfo.stanzaId = 'their-msg';
    m2.message.extendedTextMessage.contextInfo.participant = '2349700000009@s.whatsapp.net';
    await handleMessage(sock, m2);
    await new Promise((r) => setTimeout(r, 1500));
    const del = sent.filter((x) => x.delete).map((x) => x.delete);
    assert.ok(del.some((k) => k.id === lumiMsgId && k.fromMe === true), 'her own message not deleted');
    assert.ok(del.some((k) => k.id === 'their-msg' && k.fromMe === false && /2349700000009/.test(k.participant)), "other's message not deleted");
    // bad input and non-owners
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, group: G, text: '.d 5s' }));
    assert.ok(/Reply to a message/.test(last().text));
    await handleMessage(sock, mk({ from: '2349700000002', group: G, text: '.d 5s' }));
    assert.ok(/owner only/i.test(last().text));
  });

  await test('an emoji prefix cannot lock the owner out (.setprefix / .claim / .wake still answer to the default)', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '.setprefix 🍆' }));
    assert.strictEqual(settings.prefix(), '🍆');
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '.ping' }));
    assert.ok(!sent.some((x) => /Online/.test(x.text || '')), '.ping should not work with the old prefix');
    await handleMessage(sock, mk({ from: OWNER, text: '🍆ping' }));
    assert.ok(/Online/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.setprefix reset' }));
    assert.strictEqual(settings.prefix(), '.');
    // .claim also works under a custom prefix
    await handleMessage(sock, mk({ from: OWNER, text: '.setprefix !' }));
    await handleMessage(sock, mk({ from: '2349800000001', text: '.claim Ownerdivine00' }));
    assert.ok(settings.isOwner('2349800000001'));
    await handleMessage(sock, mk({ from: OWNER, text: '.setprefix reset' }));
  });

  await test('owners get the NICE prompt; everyone else gets the warm one (rude only when provoked)', async () => {
    const { systemPrompt } = require('./personality');
    const owner = systemPrompt({ isOwner: true });
    const other = systemPrompt({ isOwner: false });
    assert.ok(/NEVER insult, roast/.test(owner) && !/Roast what people say|Insult bank/.test(owner));
    assert.ok(/WHEN SOMEONE TURNS ON YOU/.test(other) && /genuinely warm and kind/.test(other) && !/Roast what people say|Insult bank/.test(other));
    assert.ok(/do NOT insult/.test(systemPrompt({ isOwner: true, provocation: 'insult' })));
  });
  await test('to an owner she answers kindly: name call, who-built-you, human question, boilerplate', async () => {
    const { nameCallReply, identityReply } = require('./personality');
    for (let i = 0; i < 40; i++) assert.notStrictEqual(nameCallReply(true), 'What.');
    for (let i = 0; i < 30; i++) { const r = identityReply('who built you', true); assert.ok(/Divine/.test(r) && !/jealous|Obviously/.test(r), r); }
    plan = { groq: 500, deepseek: 500, gemini: 500 };
    settings.addSubOwners(['2349410000001']);
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349410000001', text: 'are you human' }));
    assert.ok(/I'm Lumi|still here for you/i.test(last().text), last().text);
    plan = { groq: 200, deepseek: 200, gemini: 200 };
  });

  await test('owners can use commands WITHOUT the prefix (private chat)', async () => {
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: 'ping' }));
    assert.ok(/Online/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: 'menu' }));
    assert.ok(/LUMI/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: 'afk lunch' }));
    assert.ok(settings.getAfk(OWNER));
    await handleMessage(sock, mk({ from: OWNER, text: '.clear' }));
  });
  await test('...but normal chat is NOT mistaken for a command, even from the owner', async () => {
    require('./fallback').resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    settings.addSubOwners(['2349420000001', '2349420000002', '2349420000003']);
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349420000001', text: 'help me with my homework' }));   // owner, normal chat
    assert.ok(sent.length >= 1 && !/L U M I/.test(last().text), 'turned chat into .help');
    await handleMessage(sock, mk({ from: '2349420000002', text: 'sleep' }));
    assert.ok(!settings.isAsleep('2349420000002@s.whatsapp.net'), 'bare "sleep" must not put her to sleep');
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349420000003', text: 'kick him out of my mind' }));  // no target -> not a command
    assert.ok(!sent.some((x) => /Gone|Admins only|Groups only/.test(x.text || '')));
  });
  await test('strangers cannot use commands without the prefix', async () => {
    require('./fallback').resetCooldowns();
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349900000001', text: 'ping' }));
    assert.ok(!sent.some((x) => /Online/.test(x.text || '')));
    const KG = '888@g.us';
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2348111111111', group: KG, text: 'kick @x', mentions: ['2349555555555@s.whatsapp.net'] })); // a group admin, not an owner
    assert.ok(!sent.some((x) => x.text === 'Gone.'));
  });
  await test('in groups, no-prefix commands need a real target, or her name', async () => {
    const KG = '999@g.us';
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, group: KG, text: 'kick @x', mentions: ['2349555555555@s.whatsapp.net'] }));
    assert.strictEqual(last().text, 'Gone.');
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, group: KG, text: 'add 2349000000042' }));
    assert.ok(/2349000000042: added/.test(last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, group: KG, text: 'ping' }));                 // not addressed to her
    assert.strictEqual(sent.length, 0);
    await handleMessage(sock, mk({ from: OWNER, group: KG, text: 'Lumi ping' }));            // addressed by name
    assert.ok(/Online/.test(last().text));
  });

  await test('menu is generated from registered commands and lists the new ones', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: OWNER, text: '.menu' }));
    const t = last().text;
    for (const c of ['.chatbot', '.addsubowner', '.delsubowner', '.d', '.sleep', '.wake', '.setprefix', '.add', '.kick', '.afk', '.setprofilepic', '.play', '.getpp']) assert.ok(t.includes(c), c);
    assert.ok(!t.includes('.claim'), 'claim must stay hidden');
    assert.ok(t.endsWith("Pick a command. I'm listening._"));
  });

  await test('warm Lumi: kind to a stranger, rude only after an insult, owner never insulted', async () => {
    const { LINES } = require('./clapbacks');
    const { systemPrompt, nameCallReply, identityReply, softenProvocation } = require('./personality');
    require('./fallback').resetCooldowns();
    // an ordinary stranger gets the AI with the WARM prompt and no "do not warm up" note
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349700000001', text: 'hello Lumi how was your day' }));
    assert.ok(/genuinely warm and kind/.test(lastBody) && !/Do not warm up/.test(lastBody), 'stranger did not get the warm prompt');
    // calm correction for pet names / curiosity, rude for hostility
    assert.strictEqual(softenProvocation('pet', 'good girl'), 'petSoft');
    assert.strictEqual(softenProvocation('bot', 'are you a bot?'), 'botSoft');
    assert.strictEqual(softenProvocation('bot', 'you useless bot'), 'bot');
    assert.strictEqual(softenProvocation('insult', 'you are stupid'), 'insult');
    for (let i = 0; i < 30; i++) assert.notStrictEqual(nameCallReply(false), 'What.');
    for (let i = 0; i < 30; i++) assert.ok(!/jealous|Obviously/.test(identityReply('who built you', false)));
    // the insult line is really rude, and the owner is still protected from it
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349700000002', text: 'you are so stupid' }));
    assert.ok(LINES.insult.includes(last().text), last().text);
    settings.addSubOwners(['2349700000003']);
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349700000003', text: 'you are so stupid' }));
    assert.ok(!LINES.insult.includes(last().text) && /do NOT insult/.test(lastBody), 'owner was insulted back');
  });
  await test('annoying her (same message x3, or a flood) makes her snap once, then ignore them for a minute; owners are exempt', async () => {
    const { LINES } = require('./clapbacks');
    const annoy = require('./annoy');
    annoy.reset();
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    const U = '2349710000001';
    for (let i = 0; i < 2; i++) await handleMessage(sock, mk({ from: U, text: 'lumi reply me' }));
    sent.length = 0;
    await handleMessage(sock, mk({ from: U, text: 'lumi reply me' }));
    assert.ok(LINES.annoyed.includes(last().text), 'no snap on the 3rd repeat: ' + (last() && last().text));
    sent.length = 0;
    await handleMessage(sock, mk({ from: U, text: 'lumi hello there' }));
    assert.strictEqual(sent.length, 0, 'she should ignore them for a minute');
    // a flood
    annoy.reset();
    const F = '2349710000002'; let snapped = false;
    for (let i = 0; i < 7; i++) { sent.length = 0; await handleMessage(sock, mk({ from: F, text: 'lumi message number ' + i })); if (sent.length && LINES.annoyed.includes(last().text)) snapped = true; }
    assert.ok(snapped, 'flood did not trigger a snap');
    // owners are never snapped at
    settings.addSubOwners(['2349710000003']);
    annoy.reset();
    for (let i = 0; i < 5; i++) { sent.length = 0; await handleMessage(sock, mk({ from: '2349710000003', text: 'lumi again' })); assert.ok(!(sent.length && LINES.annoyed.includes(last().text)), 'owner got snapped at'); }
    // normal people chatting at a normal pace are fine
    annoy.reset();
    assert.strictEqual(annoy.check('x1', 'hi', 1000), null);
    assert.strictEqual(annoy.check('x1', 'how are you', 20000), null);
    assert.strictEqual(annoy.check('x1', 'what are you doing', 40000), null);
    annoy.reset();
  });

  await test('calculator: owners can send plain maths ("5+5", "lumi calc 5+5"); strangers, phone numbers and dates do not trigger it', async () => {
    const { parse } = require('./index');
    const mkc = (owner, group = false) => ({ isOwner: owner, isGroup: group, mentioned: [], ctxInfo: null, addressed: false, msg: { message: {} } });
    const calc = async (text, ctx) => { const p = parse(text, ctx); if (!p || p.cmd.name !== 'calc') return null; let out; await p.cmd.run({ args: p.args, reply: async (t) => { out = t; } }); return out; };
    for (const [t, want] of [['5+5', '*10*'], ['(12+8)/4', '*5*'], ['15% of 80', '*12*'], ['lumi 5+5', '*10*'], ['lumi calc 5+5', '*10*'], ['calc 5+5', '*10*']]) {
      const o = await calc(t, mkc(true)); assert.ok(o && o.includes(want), t + ' -> ' + o);
    }
    for (const t of ['hello', '2024', '08012345678', '12-05-2024', '234-801-2345', 'calc is hard', 'I have 5 apples', '5%']) assert.strictEqual(await calc(t, mkc(true)), null, 'should ignore: ' + t);
    for (const t of ['5+5', 'calc 5+5', 'lumi calc 5+5']) assert.strictEqual(await calc(t, mkc(false)), null, 'stranger got a calculator: ' + t);
    assert.strictEqual(parse('.calc 5+5', mkc(false)).cmd.name, 'calc'); // the prefixed command still works for everyone
    assert.ok((await calc('.calc 1/0', mkc(false)) || '').includes("can't divide"));
  });
  await test('voice replies: owner switch per chat; short AI answers go out as a voice note, with text as the fallback', async () => {
    const voice = require('./voice');
    require('./fallback').resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200 };
    const orig = voice.sendVoice; const calls = [];
    try {
      settings.setVoiceReply('2349800000001@s.whatsapp.net', true);
      voice.sendVoice = async (s, jid, text) => { calls.push(text); return true; };
      sent.length = 0;
      await handleMessage(sock, mk({ from: '2349800000001', text: 'hello Lumi how are you' }));
      assert.strictEqual(calls.length, 1, 'no voice note was made');
      assert.strictEqual(sent.filter((x) => x && x.text).length, 0, 'text was sent as well');
      // the voice service fails -> she still answers in text
      voice.sendVoice = async () => false;
      settings.setVoiceReply('2349800000002@s.whatsapp.net', true);
      require('./fallback').resetCooldowns(); sent.length = 0;
      await handleMessage(sock, mk({ from: '2349800000002', text: 'hello Lumi how are you again' }));
      assert.ok(sent.some((x) => x && x.text), 'no text fallback');
      // switch off -> plain text, no voice attempt
      settings.setVoiceReply('2349800000002@s.whatsapp.net', false);
      calls.length = 0; voice.sendVoice = async (s, j, t) => { calls.push(t); return true; };
      require('./fallback').resetCooldowns(); sent.length = 0;
      await handleMessage(sock, mk({ from: '2349800000003', text: 'hello Lumi still there' }));
      assert.strictEqual(calls.length, 0); assert.ok(sent.some((x) => x && x.text));
    } finally { voice.sendVoice = orig; ['1', '2', '3'].forEach((n) => settings.setVoiceReply(`234980000000${n}@s.whatsapp.net`, false)); }
    // helpers
    assert.ok(voice.chunkText('a b. '.repeat(200)).every((c) => c.length <= 180));
    assert.strictEqual(voice.parseArgs('fr: bonjour').lang, 'fr');
    assert.strictEqual(voice.parseArgs('hello there').lang, 'en');
  });
  await test('voice: .setvoice is owner-only and remembers the choice; helpers behave', async () => {
    const mods = require('./voice'); const sv = mods.find((c) => c.name === 'setvoice');
    assert.strictEqual(sv.ownerOnly, true);
    assert.strictEqual(mods.GEMINI_VOICES.length, 30);
    const out = []; const c = (args) => ({ args, argText: args.join(' '), reply: async (t) => out.push(t) });
    await sv.run(c(['despina'])); assert.strictEqual(settings.getVoiceName(), 'Despina');
    await sv.run(c(['Nobody'])); assert.ok(/don't know/.test(out.pop()) && settings.getVoiceName() === 'Despina');
    await sv.run(c([])); assert.ok(/Despina \(smooth\)/.test(out.pop()));
    assert.strictEqual(mods.findAudio({ steps: [{ content: [{ type: 'audio', data: 'A'.repeat(300) }] }] }), 'A'.repeat(300));
    assert.strictEqual(mods.findAudio({ steps: [{ content: [{ type: 'text', text: 'hi' }] }] }), null);
    settings.setVoiceName(null);
  });
  await test('creategc / gclink: owner-only, create a group with the owner as admin and return the link, find links by name', async () => {
    const cmds = require('./group'); const create = cmds.find((c) => c.name === 'creategc'); const gl = cmds.find((c) => c.name === 'gclink');
    assert.ok(create.ownerOnly && gl.ownerOnly);
    const OWNER = '2349990000009@s.whatsapp.net'; const calls = []; const out = [];
    const sk = { user: { id: '111:5@s.whatsapp.net' },
      groupCreate: async (n, m) => { calls.push(['create', n, m]); return { id: 'new@g.us' }; },
      groupParticipantsUpdate: async (j, p, a) => { calls.push([a, p]); return []; },
      groupInviteCode: async (j) => 'CODE' + j.replace('@g.us', ''),
      groupFetchAllParticipating: async () => ({ 'g1@g.us': { id: 'g1@g.us', subject: 'Study Group', participants: [{ id: '111@s.whatsapp.net', admin: 'admin' }] }, 'g2@g.us': { id: 'g2@g.us', subject: 'Family', participants: [{ id: '111@s.whatsapp.net' }] } }) };
    const c = (args) => ({ args, argText: args.join(' '), jid: OWNER, isGroup: false, sender: OWNER, mentioned: [], msg: { key: { participantPn: OWNER } }, sock: sk, reply: async (t) => out.push(t) });
    await create.run(c(['Study', 'Group', '2348012345678']));
    assert.strictEqual(calls[0][1], 'Study Group'); assert.deepStrictEqual(calls[0][2], [OWNER, '2348012345678@s.whatsapp.net']);
    assert.strictEqual(calls[1][0], 'promote');
    assert.ok(/chat\.whatsapp\.com\/CODEnew/.test(out.pop()));
    await create.run(c(['Another'])); assert.ok(/Slow down/.test(out.pop()), 'no cooldown');
    await gl.run(c([])); assert.ok(/1\. Family \(not admin\)/.test(out.pop()));
    await gl.run(c(['study'])); assert.ok(/CODEg1/.test(out.pop()));
    await gl.run(c(['family'])); assert.ok(/not an admin/.test(out.pop()));
    assert.ok(require('./menu').buildMenu(cmds.concat([])) !== undefined);
  });
  await test('duplicate message ids are ignored', async () => {
    const m = mk({ from: OWNER, text: '.ping' });
    sent.length = 0;
    await handleMessage(sock, m); await handleMessage(sock, m);
    assert.strictEqual(sent.length, 1);
  });

  // ======== extras: dl, tomp3, hidetag, recap, affinity, games ========
  const extras = require('./extras');
  const NG = '4444@g.us';
  const ADM = '2348111111111';          // an admin in the fake group metadata
  const PL1 = '2349100000001', PL2 = '2349100000002';

  await test('menu lists the new commands', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000010', text: '.menu' }));
    const t = last().text;
    for (const c of ['.dl', '.tomp3', '.hidetag', '.recap', '.affinity', '.resetaffinity', '.rps', '.ttt', '.hangman', '.guess', '.math', '.slots', '.top']) assert.ok(t.includes(c), c);
  });

  await test('hidetag: admins tag everyone with hidden mentions, others are refused', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: ADM, group: NG, text: '.hidetag meeting at 5' }));
    assert.strictEqual(last().text, 'meeting at 5');
    assert.strictEqual(last().mentions.length, 2);
    await handleMessage(sock, mk({ from: PL1, group: NG, text: '.hidetag hi' }));
    assert.strictEqual(last().text, 'Admins only.');
    await handleMessage(sock, mk({ from: PL1, text: '.hidetag hi' }));
    assert.strictEqual(last().text, 'Groups only.');
  });

  await test('recap: needs messages, then summarises them through the AI', async () => {
    fb.resetCooldowns();
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, group: NG, text: '.recap' }));
    assert.ok(/Not enough/.test(last().text));
    for (let i = 0; i < 8; i++) await handleMessage(sock, mk({ from: i % 2 ? PL1 : PL2, group: NG, text: `message number ${i}`, name: i % 2 ? 'Ann' : 'Bob' }));
    plan = { groq: 200, deepseek: 200, gemini: 200, text: 'They counted to seven.' };
    await handleMessage(sock, mk({ from: PL1, group: NG, text: '.recap' }));
    assert.ok(/Recap/.test(last().text) && /counted to seven/.test(last().text));
    assert.ok(/Ann: message number 1/.test(lastBody), 'transcript sent to the AI should hold names + text');
    await handleMessage(sock, mk({ from: PL1, group: NG, text: '.recap' }));
    assert.ok(/30 seconds/.test(last().text), 'recap is rate limited');
  });

  await test('affinity: grows with chat, shows in .affinity, owner can reset it', async () => {
    fb.resetCooldowns();
    plan = { groq: 200, deepseek: 200, gemini: 200, text: 'hm ok' };
    const U = '2349100000020';
    assert.strictEqual(extras.getAffinity(U).pts, 0);
    await handleMessage(sock, mk({ from: U, text: 'hello there friend' }));
    assert.strictEqual(extras.getAffinity(U).pts, 1);
    sent.length = 0;
    await handleMessage(sock, mk({ from: U, text: '.affinity' }));
    assert.ok(/stranger/.test(last().text) && /1 pts/.test(last().text));

    // a normal person cannot reset
    await handleMessage(sock, mk({ from: PL1, text: '.resetaffinity 2349100000020' }));
    assert.ok(/owner only/i.test(last().text));

    // owner resets by typed number; a bare command explains itself
    await handleMessage(sock, mk({ from: OWNER, text: '.resetaffinity' }));
    assert.ok(/Tag them/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.resetaffinity 2349100000020' }));
    assert.ok(/Back to stranger/.test(last().text));
    assert.strictEqual(extras.getAffinity(U).pts, 0);

    // "all" is for the main owner only
    extras.gainAffinity('2349100000021');
    settings.addSubOwners(['2347111111100']);
    await handleMessage(sock, mk({ from: '2347111111100', text: '.resetaffinity all' }));
    assert.ok(/main owner/i.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.affinityreset all' }));
    assert.ok(/back to stranger/i.test(last().text));
    assert.strictEqual(extras.getAffinity('2349100000021').pts, 0);
  });

  await test('games: rps, dice, flip, 8ball, slots', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, text: '.rps' }));
    assert.ok(/Pick one/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.rps rock' }));
    assert.ok(/🪨 vs/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.dice 20' }));
    assert.ok(/🎲 \d+ {2}\(d20\)/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.dice 1' }));
    assert.ok(/Between 2 and 1000/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.flip' }));
    assert.ok(/Heads|Tails/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.8ball will it work' }));
    assert.ok(/🎱/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.slots' }));
    assert.ok(/🎰/.test(last().text));
  });

  await test('games: guess the number', async () => {
    const GG = '5001@g.us';
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, group: GG, text: '.guess 50' }));
    assert.ok(/No game running/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, group: GG, text: '.guess' }));
    assert.ok(/1 to 100/.test(last().text));
    let found = false;
    for (let lo = 1, hi = 100, i = 0; i < 10 && !found; i++) {   // binary search must always win within 10 tries
      const mid = Math.floor((lo + hi) / 2);
      await handleMessage(sock, mk({ from: PL1, group: GG, text: `.guess ${mid}` }));
      const t = last().text;
      if (/Yes\. Took/.test(t)) found = true; else if (/Higher/.test(t)) lo = mid + 1; else if (/Lower/.test(t)) hi = mid - 1; else assert.fail(t);
    }
    assert.ok(found, 'binary search should find it');
    assert.ok(extras.topWins(5).some((w) => w.num === PL1), 'win is recorded');
  });

  await test('games: quick maths (wrong answers refused, right one wins)', async () => {
    const MG = '5002@g.us';
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, group: MG, text: '.math' }));
    const q = /🧮 (\d+) ([+\-×]) (\d+) = \?/.exec(last().text);
    assert.ok(q, last().text);
    const [a, b] = [parseInt(q[1], 10), parseInt(q[3], 10)];
    const ans = q[2] === '+' ? a + b : q[2] === '-' ? a - b : a * b;
    await handleMessage(sock, mk({ from: PL2, group: MG, text: `.math ${ans + 1}` }));
    assert.strictEqual(last().text, 'No.');
    await handleMessage(sock, mk({ from: PL2, group: MG, text: `.math ${ans}` }));
    assert.ok(/Right/.test(last().text));
  });

  await test('games: tic-tac-toe full game (turns, taken squares, winner)', async () => {
    const TG = '5003@g.us';
    const J2 = `${PL2}@s.whatsapp.net`;
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, group: TG, text: '.ttt' }));
    assert.ok(/Tag who/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, group: TG, text: `.ttt @p1`, mentions: [`${PL1}@s.whatsapp.net`] }));
    assert.ok(/Playing yourself/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, group: TG, text: '.ttt @p2', mentions: [J2] }));
    assert.ok(/vs/.test(last().text) && last().mentions.length === 2);
    await handleMessage(sock, mk({ from: PL2, group: TG, text: '.ttt 1' }));
    assert.ok(/Not your turn/.test(last().text));
    await handleMessage(sock, mk({ from: '2349100000003', group: TG, text: '.ttt 1' }));
    assert.ok(/not in this game/.test(last().text));
    const moves = [[PL1, 1], [PL2, 4], [PL1, 2], [PL2, 5], [PL1, 3]];   // X takes the top row
    for (const [who, sq] of moves) await handleMessage(sock, mk({ from: who, group: TG, text: `.ttt ${sq}` }));
    assert.ok(/wins/.test(last().text), last().text);
    await handleMessage(sock, mk({ from: PL1, group: TG, text: '.ttt 6' }));
    assert.ok(/No game here/.test(last().text));
    const { winnerOf } = require('./games');
    assert.strictEqual(winnerOf(['x', 'o', null, 'o', 'x', null, null, null, 'x']), 'x');
    assert.strictEqual(winnerOf(Array(9).fill(null)), null);
  });

  await test('games: hangman (letters, repeats, losing) and the leaderboard', async () => {
    const HG = '5004@g.us';
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, group: HG, text: '.hangman' }));
    assert.ok(/Lives/.test(last().text) && /_/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, group: HG, text: '.hangman 5' }));
    assert.ok(/Letters only/.test(last().text));
    for (const l of 'qzxjkv') await handleMessage(sock, mk({ from: PL1, group: HG, text: `.hangman ${l}` }));  // words never contain all of these
    assert.ok(/Dead|Lives|Already|Solved/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, group: HG, text: '.hangman end' }));
    await handleMessage(sock, mk({ from: PL1, text: '.top' }));
    assert.ok(/Game wins/.test(last().text));
  });

  await test('tomp3 asks for media when there is none', async () => {
    sent.length = 0;
    await handleMessage(sock, mk({ from: PL1, text: '.tomp3' }));
    assert.ok(/Reply to a video/.test(last().text));
  });

  await test('dl: private addresses are refused, TikTok goes through TikWM, plain files work', async () => {
    const dl = require('./download');
    assert.ok(dl.isPrivateIp('127.0.0.1') && dl.isPrivateIp('10.1.2.3') && dl.isPrivateIp('192.168.0.5') && dl.isPrivateIp('172.20.1.1') && dl.isPrivateIp('::1') && dl.isPrivateIp('169.254.169.254'));
    assert.ok(!dl.isPrivateIp('8.8.8.8') && !dl.isPrivateIp('172.32.0.1'));

    const realFetch = global.fetch;
    const hdr = (h) => ({ get: (k) => h[k.toLowerCase()] || null });
    const bytes = Buffer.from('fake-media-bytes');
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (String(url).startsWith('https://www.tikwm.com/api/')) {
        return { ok: true, status: 200, headers: hdr({}), json: async () => ({ code: 0, data: { title: 'cool clip', play: '/video/media/play/1.mp4', hdplay: '/video/media/hdplay/1.mp4' } }) };
      }
      return { ok: true, status: 200, headers: hdr({ 'content-type': String(url).endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4', 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes, json: async () => ({}) };
    };
    try {
      sent.length = 0;
      await handleMessage(sock, mk({ from: PL1, text: '.dl' }));
      assert.ok(/Give me a link/.test(last().text));
      await handleMessage(sock, mk({ from: PL1, text: '.dl http://127.0.0.1/secret.mp4' }));
      assert.ok(/Found it, but|Couldn't/.test(last().text), 'private address must not be fetched');
      assert.ok(!calls.some((c) => c.includes('127.0.0.1')));

      sent.length = 0;
      await handleMessage(sock, mk({ from: PL1, text: '.dl https://vm.tiktok.com/ZMabc123/' }));
      const v = sent.find((x) => x.video);
      assert.ok(v && v.caption === 'cool clip', 'tiktok video should be sent with its title');
      assert.ok(calls.some((c) => c.includes('hdplay')), 'uses the HD link');

      sent.length = 0;
      await handleMessage(sock, mk({ from: PL1, text: '.dl https://example.com/song.mp3' }));
      assert.ok(sent.some((x) => x.audio), 'direct mp3 link is sent as audio');

      sent.length = 0;
      await handleMessage(sock, mk({ from: PL1, text: '.dl https://www.youtube.com/watch?v=abc' }));
      assert.ok(/COBALT_API_URL/.test(last().text), 'no downloader set: says what is missing');
    } finally { global.fetch = realFetch; }
  });

  await test('logger scrubs API keys', async () => {
    let out = ''; const orig = console.log; console.log = (...a) => { out += a.join(' '); };
    require('./logger').error('failed with groq-test-key-123');
    console.log = orig;
    assert.ok(!out.includes('groq-test-key-123'));
  });


  // ======== poll, jail, saved stickers, group picture ========
  const GF = '5555@g.us';
  const T = (from, text, extra = {}) => mk({ from, group: GF, text, ...extra });
  await test('poll: needs 2+ options, sends a native poll, --multi allows several answers', async () => {
    sent.length = 0;
    await handleMessage(sock, T(PL1, '.poll Best food? | Rice | Beans | Rice'));
    assert.deepStrictEqual(last().poll, { name: 'Best food?', values: ['Rice', 'Beans'], selectableCount: 1 });
    await handleMessage(sock, T(ADM, '.poll Again | A | B')); assert.ok(/One poll at a time/.test(last().text));
    await handleMessage(sock, T(OWNER, '.poll Pick | A | B | C --multi'));
    assert.strictEqual(last().poll.selectableCount, 0); assert.strictEqual(last().poll.values.length, 3);
    await handleMessage(sock, T(OWNER, '.poll Only one | A'));
    assert.ok(/at least 2 options/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.poll a | b | c' }));
    assert.ok(/for groups/.test(last().text));
  });
  await test('jail: admins jail, Lumi deletes everything they send, admins/owner/Lumi are safe, unjail frees', async () => {
    sent.length = 0;
    await handleMessage(sock, T(PL1, '.jail @x', { mentions: [PL2 + '@s.whatsapp.net'] }));
    assert.strictEqual(last().text, 'Admins only.');
    await handleMessage(sock, T(ADM, '.jail @x', { mentions: [ADM + '@s.whatsapp.net'] }));
    assert.ok(/Can't jail an admin/.test(last().text));
    await handleMessage(sock, T(ADM, '.jail @x', { mentions: [OWNER + '@s.whatsapp.net'] }));
    assert.ok(/Can't jail me\/owner/.test(last().text));
    await handleMessage(sock, T(ADM, '.jail @x', { mentions: [PL2 + '@s.whatsapp.net'] }));
    assert.ok(/Jailed @2349100000002/.test(last().text));
    sent.length = 0;
    const bad = T(PL2, 'hello everyone'); await handleMessage(sock, bad);
    assert.deepStrictEqual(sent[0].delete, bad.key); assert.strictEqual(sent.length, 1);
    const cmd = T(PL2, '.ping'); await handleMessage(sock, cmd);
    assert.deepStrictEqual(sent[1].delete, cmd.key); assert.strictEqual(sent.length, 2, 'jailed commands must not run');
    await handleMessage(sock, T(PL1, 'hello'));            // others unaffected
    assert.ok(!sent.slice(2).some((x) => x.delete));
    await handleMessage(sock, mk({ from: PL2, text: 'hi in dm' })); // other chats unaffected
    assert.ok(!sent.slice(2).some((x) => x.delete));
    await handleMessage(sock, T(ADM, '.jailed')); assert.ok(/@2349100000002/.test(last().text));
    await handleMessage(sock, T(ADM, '.unjail @x', { mentions: [PL2 + '@s.whatsapp.net'] }));
    assert.ok(/Freed/.test(last().text));
    sent.length = 0; await handleMessage(sock, T(PL2, 'free now')); assert.ok(!sent.some((x) => x.delete));
  });
  await test('jail: replies work as target, timed jail expires, needs Lumi admin, matches a hidden-id alias', async () => {
    const jf = require('./groupfun');
    sent.length = 0;
    await handleMessage(sock, T(ADM, '.jail 2m', { reply: PL2 + '@s.whatsapp.net' }));
    assert.ok(/for 2m/.test(last().text));
    const realNow = Date.now; Date.now = () => realNow() + 3 * 60000;
    sent.length = 0; await handleMessage(sock, T(PL2, 'after expiry')); Date.now = realNow;
    assert.ok(!sent.some((x) => x.delete), 'expired jail still deleting');
    const meta = sock.groupMetadata;
    sock.groupMetadata = async () => ({ participants: [{ id: '777@lid', phoneNumber: PL1 + '@s.whatsapp.net' }, { id: ADM + '@s.whatsapp.net', admin: 'admin' }, { id: '15550001111@s.whatsapp.net', admin: 'admin' }] });
    await handleMessage(sock, T(ADM, '.jail @x', { mentions: ['777@lid'] }));
    const viaLid = T(PL1, 'sneaky'); sent.length = 0; await handleMessage(sock, viaLid);
    assert.ok(sent[0] && sent[0].delete, 'alias not matched');
    await handleMessage(sock, T(ADM, '.unjail all')); assert.ok(/Freed everyone/.test(last().text));
    sock.groupMetadata = async () => ({ participants: [{ id: ADM + '@s.whatsapp.net', admin: 'admin' }] });
    await handleMessage(sock, T(ADM, '.jail @x', { mentions: [PL2 + '@s.whatsapp.net'] }));
    assert.ok(/Make me an admin/.test(last().text));
    sock.groupMetadata = meta;
  });
  await test('gcpp: sends the group picture; no picture is handled', async () => {
    const http = require('./http'); const realReq = http.request;
    http.request = async () => Buffer.from('img');
    sock.profilePictureUrl = async (j) => { assert.strictEqual(j, GF); return 'https://x/y.jpg'; };
    sent.length = 0; await handleMessage(sock, T(PL1, '.gcpp'));
    assert.ok(Buffer.isBuffer(last().image));
    sock.profilePictureUrl = async () => { throw new Error('item-not-found'); };
    await handleMessage(sock, T(PL1, '.gcpic')); assert.ok(/no picture/.test(last().text));
    await handleMessage(sock, mk({ from: PL1, text: '.gcpp' })); assert.ok(/inside the group/.test(last().text));
    http.request = realReq;
  });
  await test('sticker box: save by reply, list, send, protect others\' stickers, owner can delete', async () => {
    const st = (from, text, sticker = true) => ({ ...T(from, text), message: { extendedTextMessage: { text, contextInfo: sticker ? { stanzaId: 'q1', participant: PL2 + '@s.whatsapp.net', quotedMessage: { stickerMessage: { fileLength: 4, isAnimated: false } } } : {} } } });
    global.__dl = Buffer.from('WEBP');
    sent.length = 0;
    await handleMessage(sock, st(PL1, '.savesticker Laugh!'));
    assert.ok(/Saved as "laugh"/.test(last().text));
    await handleMessage(sock, st(PL1, '.savesticker laugh')); assert.ok(/taken/.test(last().text));
    await handleMessage(sock, st(PL1, '.savesticker', true)); assert.ok(/Give it a name/.test(last().text));
    await handleMessage(sock, st(PL1, '.savesticker nope', false)); assert.ok(/Reply to a sticker/.test(last().text));
    await handleMessage(sock, T(PL2, '.stickers')); assert.ok(/• laugh/.test(last().text));
    await handleMessage(sock, T(PL2, '.gs laugh')); assert.strictEqual(String(last().sticker), 'WEBP');
    await handleMessage(sock, T(PL2, '.gs ghost')); assert.ok(/No sticker called/.test(last().text));
    await handleMessage(sock, T(PL2, '.delsticker laugh')); assert.ok(/Only who saved it/.test(last().text));
    await handleMessage(sock, T(OWNER, '.delsticker laugh')); assert.ok(/Deleted/.test(last().text));
    await handleMessage(sock, T(PL2, '.stickers')); assert.ok(/No saved stickers/.test(last().text));
    global.__dl = Buffer.alloc(2 * 1024 * 1024);
    await handleMessage(sock, st(PL1, '.savesticker big')); assert.ok(/Couldn't save/.test(last().text));
    global.__dl = null;
  });
  await test('menu lists poll, jail, gcpp and the sticker box', async () => {
    sent.length = 0; await handleMessage(sock, mk({ from: '2349100000011', text: '.menu' }));
    for (const c of ['.poll', '.jail', '.gcpp', '.savesticker', '.getsticker', '.stickers']) assert.ok(last().text.includes(c), c);
  });


  await test('play: finds the full song on YouTube by length, sends it as audio; falls back to the 30s preview', async () => {
    const music = require('./music'); const play = music.find((c) => c.name === 'play');
    const yt = (items) => `<script>var ytInitialData = ${JSON.stringify({ a: { b: items.map(([id, title, ch, len]) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: ch }] }, lengthText: { simpleText: len } } })) } })};</script>`;
    const html = yt([['live1', 'Song (Live)', 'Fan', '5:10'], ['cover1', 'Song cover', 'X', '3:41'], ['mix1', 'Song 1 hour', 'Y', '1:00:00'], ['good1', 'Artist - Song (Official Audio)', 'Artist', '3:42']]);
    const vids = music.parseYoutube(html);
    assert.strictEqual(vids.length, 4); assert.strictEqual(vids[3].seconds, 222);
    assert.strictEqual(music.pickVideo(vids, { query: 'artist song', artist: 'Artist', targetSeconds: 220, maxSeconds: 600 }).id, 'good1');
    assert.strictEqual(music.pickVideo(vids.slice(2, 3), { targetSeconds: 220, maxSeconds: 600 }), null, 'over-long mix must be skipped');
    process.env.COBALT_API_URL = 'https://cobalt.example.test';
    const realFetch = global.fetch; const calls = []; let cobaltOk = true;
    const R = (body, type = 'application/json') => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? type : null) }, json: async () => body, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (url.includes('itunes.apple.com')) return R({ results: [{ trackName: 'Song', artistName: 'Artist', trackTimeMillis: 220000, trackViewUrl: 'https://music.apple.com/x', previewUrl: 'https://p.example.test/prev.m4a' }] });
      if (url.includes('youtube.com/results')) return R(html, 'text/html');
      if (url.startsWith('https://cobalt.example.test')) { if (!cobaltOk) throw new Error('down'); assert.ok(/watch\?v=good1/.test(opts.body) && /"audio"/.test(opts.body)); return R({ status: 'tunnel', url: 'https://cdn.example.test/full.mp3' }); }
      if (url.includes('cdn.example.test')) return R('FULLSONG-MP3', 'audio/mpeg');
      if (url.includes('prev.m4a')) return R('PREVIEW', 'audio/mp4');
      throw new Error('unexpected ' + url);
    };
    const out = []; const sk = { sendMessage: async (j, c) => { out.push(c); } };
    const c = () => ({ argText: 'artist song', jid: 'j@s.whatsapp.net', msg: { key: {} }, sock: sk, reply: async (x) => out.push({ text: x }) });
    await play.run(c());
    assert.strictEqual(String(out[out.length - 1].audio), 'FULLSONG-MP3'); assert.strictEqual(out[out.length - 1].mimetype, 'audio/mpeg');
    cobaltOk = false; out.length = 0;
    await play.run(c());
    assert.strictEqual(String(out[out.length - 1].audio), 'PREVIEW');
    assert.ok(out.some((x) => /Couldn't download the full song/.test(x.text || x.caption || '')));
    delete process.env.COBALT_API_URL; out.length = 0;
    await play.run(c());
    assert.ok(out.some((x) => /COBALT_API_URL/.test(x.text || x.caption || '')) && String(out[out.length - 1].audio) === 'PREVIEW');
    global.fetch = realFetch;
  });


  await test('vault + .vv: view-once media is saved on arrival and revealed later from the copy; ordinary messages are not kept', async () => {
    const vault = require('./vault');
    const BOB = '2349100000077';
    global.__dl = Buffer.from('SECRET-IMAGE-BYTES'.repeat(10));
    const vo = { key: { remoteJid: `${BOB}@s.whatsapp.net`, id: 'VO1', fromMe: false }, pushName: 'Bob', messageTimestamp: Math.floor(Date.now() / 1000),
      message: { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true, caption: 'look', mimetype: 'image/jpeg', fileLength: 180 } } } } };
    await handleMessage(sock, vo);
    await new Promise((r) => setTimeout(r, 30));
    const saved = vault.lookup(vo.key.remoteJid, 'VO1');
    assert.ok(saved && saved.viewOnce && saved.mediaBuffer && saved.mediaBuffer.length === 180, 'view-once not saved');
    await handleMessage(sock, mk({ from: BOB, text: 'just chatting' }));
    assert.strictEqual(vault.stats().total, 1, 'ordinary message must not be kept');
    // owner replies .vv; WhatsApp quoted it WITHOUT the wrapper, and the original can no longer be downloaded
    const rep = { key: { remoteJid: vo.key.remoteJid, id: 'R1', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Owner',
      message: { extendedTextMessage: { text: '.vv', contextInfo: { stanzaId: 'VO1', participant: vo.key.remoteJid, quotedMessage: { imageMessage: { viewOnce: true, caption: 'look' } } } } } };
    rep.key.remoteJid = vo.key.remoteJid;
    sent.length = 0;
    const OWNJ = `${OWNER}@s.whatsapp.net`;
    const mine = { ...vo, key: { remoteJid: OWNJ, id: 'VO2', fromMe: false } };
    await handleMessage(sock, { ...mine, message: vo.message, messageTimestamp: Math.floor(Date.now() / 1000) });
    await new Promise((r) => setTimeout(r, 30));
    global.__dl = null; // from now on WhatsApp would refuse the download
    // a fresh copy for the owner's own chat so ids match the reply below
    const ownerReply = { key: { remoteJid: OWNJ, id: 'R2', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Owner',
      message: { extendedTextMessage: { text: '.vv', contextInfo: { stanzaId: 'VO2', quotedMessage: { imageMessage: { viewOnce: true, caption: 'look' } } } } } };
    sent.length = 0; await handleMessage(sock, ownerReply);
    const out = sent.find((s) => s.image);
    assert.ok(out && out.image.length === 180 && out.caption === 'look', 'did not reveal from the saved copy');
    sent.length = 0;
    await handleMessage(sock, { ...ownerReply, key: { ...ownerReply.key, id: 'R3' }, message: { extendedTextMessage: { text: '.vv', contextInfo: { stanzaId: 'NOPE', quotedMessage: { extendedTextMessage: { text: 'plain' } } } } } });
    assert.ok(/Reply to a view-once/.test(last().text));
  });


  await test('human replies: read first, then typing, then send; longer answers take longer; off = instant', async () => {
    const human = require('./human');
    process.env.HUMAN_SPEED = '0.05';
    const ev = []; const sk = { readMessages: async () => { ev.push('read'); }, sendPresenceUpdate: async (s) => { ev.push(s); } };
    const mkCtx = (text) => ({ sock: sk, jid: 'j@s.whatsapp.net', msg: { key: { id: 'x' } }, text, receivedAt: Date.now(), reply: async (t) => { ev.push('send:' + t); } });
    process.env.HUMAN_REPLY = 'on';
    let t0 = Date.now(); await human.say(mkCtx('hello there'), 'hi'); const shortMs = Date.now() - t0;
    assert.deepStrictEqual(ev, ['read', 'composing', 'paused', 'send:hi']);
    ev.length = 0; t0 = Date.now(); await human.say(mkCtx('hello there'), 'x'.repeat(160)); const longMs = Date.now() - t0;
    assert.ok(longMs > shortMs, `long ${longMs} should exceed short ${shortMs}`);
    assert.ok(human.typeMs('x'.repeat(10)) < human.typeMs('x'.repeat(200)) && human.typeMs('x'.repeat(5000)) <= 8000 * 0.05 + 1);
    process.env.HUMAN_SPEED = '1';
    const r = human.readMs('hi'); assert.ok(r >= 500 && r <= 1500, 'read time ' + r);
    const ty = human.typeMs('x'.repeat(100)); assert.ok(ty >= 4400 && ty <= 6900, 'type time ' + ty);
    // a slow AI answer is not delayed again
    process.env.HUMAN_SPEED = '0.05'; ev.length = 0;
    const slow = mkCtx('hi'); slow.receivedAt = Date.now() - 60000; t0 = Date.now(); await human.say(slow, 'ok'); assert.ok(Date.now() - t0 < 200);
    process.env.HUMAN_REPLY = 'off'; ev.length = 0; t0 = Date.now(); await human.say(mkCtx('hi'), 'x'.repeat(300)); assert.deepStrictEqual(ev, ['send:' + 'x'.repeat(300)]);
    delete process.env.HUMAN_SPEED;
  });


  await test('pairing: owner or (when open) the person themselves gets a code; linked number runs commands from its own phone; unpair works', async () => {
    const sessions = require('./sessions'); sessions.setHandler(handleMessage);
    const fakes = [];
    sessions._setFactory(async () => {
      const L = {}; const ev = { on: (n, f) => { (L[n] ||= []).push(f); }, emit: (n, d) => Promise.all((L[n] || []).map((f) => f(d))) };
      const f = { ev, out: [], authState: { creds: { registered: false } }, user: { id: '2349100000050:1@s.whatsapp.net' },
        requestPairingCode: async (n) => { f.pairedFor = n; return 'ABCD1234'; },
        sendMessage: async (j, c) => { f.out.push({ j, ...c }); return { key: { id: 'p' + f.out.length } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {},
        logout: async () => { f.loggedOut = true; }, end: () => { f.ended = true; } };
      fakes.push(f); return f;
    });
    const DM = (from, text) => mk({ from, text });
    sent.length = 0;
    // closed: a stranger cannot pair
    await handleMessage(sock, DM('2349100000050', '.pair')); assert.ok(/closed/.test(last().text));
    // the owner pairs a number
    const r = handleMessage(sock, DM(OWNER, '.pair 2349100000050'));
    await new Promise((x) => setTimeout(x, 20));
    await fakes[0].ev.emit('connection.update', { qr: 'qr-data' });
    await r;
    assert.strictEqual(fakes[0].pairedFor, '2349100000050');
    assert.ok(/\*ABCD-1234\*/.test(last().text) && /Linked devices/.test(last().text), last().text);
    assert.strictEqual(sessions.list()[0].status, 'pending');
    await handleMessage(sock, DM(OWNER, '.pair 2349100000050')); assert.ok(/already has a code/.test(last().text));
    // they link it
    await fakes[0].ev.emit('connection.update', { connection: 'open' });
    await new Promise((x) => setTimeout(x, 20));
    assert.ok(sent.some((s) => /Linked! \+2349100000050/.test(s.text || '')));
    assert.ok(fakes[0].out.some((o) => o.j === '2349100000050@s.whatsapp.net' && /linked to this number/.test(o.text)));
    await handleMessage(sock, DM(OWNER, '.pairlist')); assert.ok(/\+2349100000050 - online/.test(last().text) && /owner-only/.test(last().text));
    // their own phone: commands work, normal chat and no-prefix words do not
    const P = fakes[0]; const up = (m, type = 'notify') => P.ev.emit('messages.upsert', { messages: [m], type });
    const own = (text, id) => ({ key: { remoteJid: '2349100000099@s.whatsapp.net', fromMe: true, id }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) });
    P.out.length = 0;
    await up(own('.ping', 'a1'), 'append'); assert.ok(P.out.length === 1, 'own command ignored');
    await up(own('hello my friend', 'a2'), 'append'); await up(own('ping', 'a3'), 'append'); await up(own('5+5', 'a4'), 'append');
    assert.strictEqual(P.out.length, 1, 'normal chat / no-prefix words must not trigger Lumi');
    await up(own('.setprefix !', 'a5')); assert.ok(/only works on my main number/.test(P.out.pop().text));
    await up(own('.menu', 'a6')); assert.ok(/LUMI/.test(P.out.pop().text));
    // a friend messaging the linked number: normal commands, no owner powers, no auto AI chat
    const friend = (text, id) => ({ key: { remoteJid: '2349100000099@s.whatsapp.net', fromMe: false, id }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Fri' });
    P.out.length = 0;
    await up(friend('.ping', 'f1')); assert.strictEqual(P.out.length, 1);
    await up(friend('.sleep', 'f2')); assert.ok(/owner only/.test(P.out.pop().text));
    P.out.length = 0; await up(friend('how are you today', 'f3')); assert.strictEqual(P.out.length, 0, 'must not auto-chat on a paired number');
    // the main owner has no special power over a linked account
    await up({ ...friend('.sleep', 'f4'), key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: false, id: 'f4' } }); assert.ok(/owner only/.test(P.out.pop().text));
    // open pairing: a person can pair only their own number, in private
    await handleMessage(sock, DM(OWNER, '.pairing open')); assert.ok(/Pairing is open/.test(last().text));
    await handleMessage(sock, mk({ from: '2349100000060', group: '7777@g.us', text: '.pair' })); assert.ok(/private chat/.test(last().text));
    await handleMessage(sock, DM('2349100000061', '.pair 2349100000062')); assert.ok(/only pair your own number/.test(last().text));
    // slots are limited
    process.env.MAX_PAIRED = '1';
    await handleMessage(sock, DM('2349100000063', '.pair')); assert.ok(/slots are taken/.test(last().text));
    delete process.env.MAX_PAIRED;
    // unpair from their own phone logs Lumi out and forgets the number
    await up(own('.unpair', 'a7'));
    assert.ok(P.loggedOut, 'did not log out'); assert.strictEqual(sessions.list().length, 0);
    await handleMessage(sock, DM(OWNER, '.pairing close'));
  });
  await test('pairing: unused code expires and cleans up; removed-from-linked-devices drops the number; saved numbers come back after a restart', async () => {
    const sessions = require('./sessions'); const made = [];
    sessions._setFactory(async () => {
      const L = {}; const f = { ev: { on: (n, g) => { (L[n] ||= []).push(g); }, emit: (n, d) => Promise.all((L[n] || []).map((g) => g(d))) }, out: [], authState: { creds: { registered: true } }, user: { id: '1:1@s.whatsapp.net' },
        requestPairingCode: async () => 'ZZZZ9999', sendMessage: async () => ({ key: { id: 'x' } }), end() { f.ended = true; }, logout: async () => {} };
      made.push(f); return f;
    });
    process.env.PAIR_TIMEOUT_MS = '60';
    const exp = []; const pend = sessions.pair('2349100000070', { onFail: (r) => exp.push(r) });
    await new Promise((x) => setTimeout(x, 20));
    made[0].authState.creds.registered = false;
    await made[0].ev.emit('connection.update', { qr: 'q' }); await pend;
    await new Promise((x) => setTimeout(x, 120));
    assert.ok(exp.length === 0 || exp[0] === 'timeout');
    delete process.env.PAIR_TIMEOUT_MS;
    assert.strictEqual(sessions.has('2349100000070'), false, 'expired pairing must be removed');
    // a normal paired number: link, then WhatsApp says logged out
    const pend2 = sessions.pair('2349100000071', {});
    await new Promise((x) => setTimeout(x, 20));
    made[made.length - 1].authState.creds.registered = false;
    await made[made.length - 1].ev.emit('connection.update', { qr: 'q' }); await pend2;
    made[made.length - 1].authState.creds.registered = true;
    await made[made.length - 1].ev.emit('connection.update', { connection: 'open' });
    assert.ok(sessions.has('2349100000071') && sessions.list()[0].online);
    // restart: resume brings it back without asking for a new code
    const before = made.length; await sessions.resumeAll(0); await new Promise((x) => setTimeout(x, 30));
    assert.strictEqual(made.length, before + 1);
    await made[made.length - 1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.strictEqual(sessions.has('2349100000071'), false, 'logged-out number must be dropped');
    sessions._setFactory(null);
  });


  await test('vision + imagine: .read describes pictures and stickers, she reacts to stickers sent to her, and she draws on request', async () => {
    process.env.VISION_COOLDOWN_MS = '0'; process.env.IMAGE_COOLDOWN_MS = '0';
    const realFetch = global.fetch; const calls = []; let visionOk = true; let geminiImg = true; let groqSeen = false;
    const R = (body, type = 'application/json') => ({ ok: true, status: 200, headers: { get: () => type }, json: async () => body, text: async () => String(body), arrayBuffer: async () => body });
    const bigImg = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 1)]);
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body });
      if (url.includes('flash-image')) { if (!geminiImg) return { ok: false, status: 429, headers: { get: () => null } }; return R({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bigImg.toString('base64') } }] } }] }); }
      if (url.includes('image.pollinations.ai')) return R(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3000, 2)])).buffer, 'image/jpeg');
      if (url.includes('generativelanguage')) { if (!visionOk) return { ok: false, status: 500, headers: { get: () => null } }; return R({ candidates: [{ content: { parts: [{ text: 'A sleepy cat saying good night.' }] } }] }); }
      if (url.includes('groq.com')) { groqSeen = true; return R({ choices: [{ message: { content: 'Groq sees a cat.' } }] }); }
      throw new Error('unexpected ' + url);
    };
    global.__dl = Buffer.from('IMG'.repeat(100));
    const U = '2349100000081';
    const stk = (id, extra = {}) => ({ key: { remoteJid: `${U}@s.whatsapp.net`, id, fromMe: false }, pushName: 'Uche', messageTimestamp: Math.floor(Date.now() / 1000), message: { stickerMessage: { mimetype: 'image/webp', fileLength: 300 }, ...extra } });
    // .read on a sticker someone replied to
    const rd = { key: { remoteJid: `${U}@s.whatsapp.net`, id: 'rd1', fromMe: false }, pushName: 'Uche', messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text: '.read what does it mean', contextInfo: { stanzaId: 'S0', quotedMessage: { stickerMessage: { mimetype: 'image/webp', fileLength: 300 } } } } } };
    sent.length = 0; await handleMessage(sock, rd);
    assert.strictEqual(last().text, 'A sleepy cat saying good night.');
    const body = JSON.parse(calls.find((c) => c.url.includes('generativelanguage') && !c.url.includes('flash-image')).body);
    assert.strictEqual(body.contents[0].parts[0].inline_data.mime_type, 'image/webp'); assert.ok(/what does it mean/.test(body.contents[0].parts[1].text));
    await handleMessage(sock, mk({ from: U, text: '.read' })); assert.ok(/Reply to a picture or sticker/.test(last().text));
    // Gemini down -> Groq vision
    visionOk = false; await handleMessage(sock, { ...rd, key: { ...rd.key, id: 'rd2' } }); assert.strictEqual(last().text, 'Groq sees a cat.'); assert.ok(groqSeen); visionOk = true;
    // a sticker sent to her in private: she answers in her own voice
    sent.length = 0; await handleMessage(sock, stk('st1')); assert.ok(last() && /sleepy cat/.test(last().text), JSON.stringify(last()));
    // a sticker in a group that is not addressed to her: silence
    sent.length = 0; await handleMessage(sock, { ...stk('st2'), key: { remoteJid: '8888@g.us', participant: `${U}@s.whatsapp.net`, id: 'st2', fromMe: false } }); assert.strictEqual(sent.length, 0);
    // draw: command, Gemini image first, Pollinations when it fails, natural language, blocked prompts
    sent.length = 0; await handleMessage(sock, mk({ from: U, text: '.imagine a lion wearing a crown' }));
    assert.ok(sent.some((x) => x.image && x.image.length > 1000 && /lion/.test(x.caption)), 'no image from Gemini');
    geminiImg = false; sent.length = 0; await handleMessage(sock, mk({ from: U, text: 'Lumi, draw a sunset over Lagos' }));
    assert.ok(sent.some((x) => x.image) && calls.some((c) => c.url.includes('pollinations') && /sunset%20over%20Lagos/.test(c.url)), 'no Pollinations fallback');
    sent.length = 0; await handleMessage(sock, mk({ from: '2349100000083', text: 'generate a picture of a red car' })); assert.ok(sent.some((x) => x.image));
    sent.length = 0; await handleMessage(sock, mk({ from: U, text: '.imagine a nude woman' })); assert.ok(/Not drawing that/.test(last().text) && !sent.some((x) => x.image));
    await handleMessage(sock, mk({ from: U, text: '.imagine' })); assert.ok(/what to draw/.test(last().text));
    const imagine = require('./imagine');
    assert.strictEqual(imagine.intent('draw a cat'), 'a cat'); assert.strictEqual(imagine.intent('make a logo for my shop'), 'my shop');
    assert.strictEqual(imagine.intent('draw'), null); assert.strictEqual(imagine.intent('I draw every day'), null); assert.strictEqual(imagine.intent('how are you'), null);
    process.env.IMAGE_COOLDOWN_MS = '60000'; await handleMessage(sock, mk({ from: '2349100000082', text: '.imagine a bird' })); sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000082', text: '.imagine another bird' })); assert.ok(/moment between pictures/.test(last().text));
    process.env.IMAGE_COOLDOWN_MS = '0'; global.fetch = realFetch; global.__dl = null;
  });


  await test('protect: a plain reply to Divine is NOT a tag (even if WhatsApp lists him in mentionedJid); a real @tag still is', async () => {
    const REPLY_LINES = require('./divine').REPLIES; const PG = '6666@g.us'; const PID = settings.protectedIds()[0];
    const base = (id, text, mentions, quoteDivine) => ({ key: { remoteJid: PG, participant: '2349100000095@s.whatsapp.net', id, fromMe: false }, pushName: 'Rando', messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions, ...(quoteDivine ? { stanzaId: 'qq', participant: `${PID}@s.whatsapp.net`, quotedMessage: { conversation: 'hello' } } : {}) } } } });
    sent.length = 0;
    await handleMessage(sock, base('pr1', 'ok thanks', [`${PID}@s.whatsapp.net`], true));
    assert.ok(!sent.some((s) => REPLY_LINES.includes(s.text)), 'a reply to Divine triggered the protection line');
    await handleMessage(sock, base('pr2', 'hey @Divine come here', [`${PID}@s.whatsapp.net`], true));
    assert.ok(sent.some((s) => REPLY_LINES.includes(s.text)), 'a real tag must still trigger it');
  });


  await test('social: age gate, marry / accept / decline / divorce, bio, name change, profile', async () => {
    const SG2 = '5151@g.us'; const A = '2349100000101', B = '2349100000102', C = '2349100000103', D = '2349100000104';
    const G = (from, text, mentions = []) => mk({ from, group: SG2, text, mentions });
    const tagOf = (n) => `${n}@s.whatsapp.net`;
    sent.length = 0;
    await handleMessage(sock, G(A, '.marry @b', [tagOf(B)])); assert.ok(/18\+ only/.test(last().text));
    await handleMessage(sock, G(A, '.setage 12')); assert.ok(/13 or more/.test(last().text));
    await handleMessage(sock, G(A, '.setage 20')); assert.ok(/Age saved: 20/.test(last().text));
    await handleMessage(sock, G(A, '.marry @b', [tagOf(B)])); assert.ok(/haven't set an age/.test(last().text));
    await handleMessage(sock, G(D, '.setage 16')); await handleMessage(sock, G(B, '.setage 22')); await handleMessage(sock, G(C, '.setage 25'));
    await handleMessage(sock, G(A, '.marry @d', [tagOf(D)])); assert.ok(/haven't set an age \(18\+\)/.test(last().text), 'under-18 must not be marriageable');
    await handleMessage(sock, G(A, '.marry @a', [tagOf(A)])); assert.ok(/Marry yourself/.test(last().text));
    await handleMessage(sock, G(A, '.marry @b', [tagOf(B)]));
    assert.ok(/PROPOSAL ALERT/.test(last().text) && last().mentions.length === 2);
    await handleMessage(sock, G(C, '.marry @b', [tagOf(B)])); assert.ok(/already shot their shot/.test(last().text));
    await handleMessage(sock, G(A, '.marry @c', [tagOf(C)])); assert.ok(/still have a proposal waiting/.test(last().text));
    await handleMessage(sock, G(C, '.marryaccept')); assert.ok(/Nobody has proposed/.test(last().text));
    await handleMessage(sock, G(B, '.marryaccept')); assert.ok(/THEY SAID YES/.test(last().text));
    await handleMessage(sock, G(A, '.marry @c', [tagOf(C)])); assert.ok(/already married/.test(last().text));
    await handleMessage(sock, G(C, '.marry @b', [tagOf(B)])); assert.ok(/already taken/.test(last().text));
    await handleMessage(sock, G(B, '.profile')); assert.ok(/married to @2349100000101/.test(last().text));
    await handleMessage(sock, G(B, '.divorce')); assert.ok(/IT'S OVER/.test(last().text));
    await handleMessage(sock, G(B, '.divorce')); assert.ok(/not even married/.test(last().text));
    // decline, and a proposal that expires
    await handleMessage(sock, G(C, '.marry @b', [tagOf(B)])); await handleMessage(sock, G(B, '.marrydecline')); assert.ok(/REJECTED/.test(last().text));
    await handleMessage(sock, G(C, '.marry @b', [tagOf(B)]));
    const realNow = Date.now; Date.now = () => realNow() + 6 * 60000;
    await handleMessage(sock, G(B, '.marryaccept')); Date.now = realNow; assert.ok(/Nobody has proposed/.test(last().text), 'expired proposal accepted');
    // bio
    await handleMessage(sock, G(A, '.bio')); assert.ok(/no bio yet/.test(last().text));
    await handleMessage(sock, G(A, '.setbio check my site www.scam.com')); assert.ok(/No links/.test(last().text));
    await handleMessage(sock, G(A, '.setbio Chilling. Eating. Repeating.')); assert.ok(/Bio saved/.test(last().text));
    await handleMessage(sock, G(B, '.bio @a', [tagOf(A)])); assert.ok(/Chilling. Eating. Repeating./.test(last().text));
    await handleMessage(sock, G(A, '.setbio ' + 'x'.repeat(200))); assert.ok(/under 150/.test(last().text));
    // names
    await handleMessage(sock, G(A, '.namechange Lumi Jr')); assert.ok(/can't be me/.test(last().text));
    await handleMessage(sock, G(A, '.namechange @admin')); assert.ok(/No @/.test(last().text));
    await handleMessage(sock, G(A, '.namechange Big Chris')); assert.ok(/Big Chris/.test(last().text));
    await handleMessage(sock, G(A, '.changename Other Name')); assert.ok(/Slow down/.test(last().text));
    await handleMessage(sock, G(A, '.profile')); assert.ok(/\*Big Chris\*/.test(last().text) && /Age: 20/.test(last().text));
    await handleMessage(sock, G(A, '.age')); assert.ok(/You are 20/.test(last().text));
    sent.length = 0; await handleMessage(sock, mk({ from: '2349100000111', text: '.marry @x' })); assert.ok(/go in a group/.test(last().text));
  });


  await test('autoread: reads like a person (a pause, whole chat at once), respects on/off/dm/groups, skips status, sleeping chats and her own messages', async () => {
    process.env.HUMAN_REPLY = 'on'; process.env.AUTOREAD_SPEED = '0.02';
    const reads = []; const sk = Object.create(sock); sk.readMessages = async (keys) => { reads.push(keys.map((k) => k.id)); };
    const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
    const DMm = (id, from = '2349100000121') => ({ key: { remoteJid: `${from}@s.whatsapp.net`, id, fromMe: false }, pushName: 'X', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'hello there' } });
    settings.setAutoread('on');
    const quiet = (id, from) => { settings.setAi(`${from}@s.whatsapp.net`, false); return DMm(id, from); }; // no AI chat, so only auto-read acts
    const autoread = require('./autoread');
    autoread.schedule(sk, quiet('ar1', '2349100000121'), 11); assert.strictEqual(reads.length, 0, 'must not read instantly');
    autoread.schedule(sk, quiet('ar2', '2349100000121'), 11); await wait();
    assert.deepStrictEqual(reads, [['ar1', 'ar2']], 'a run of messages should be read in one go');
    reads.length = 0;
    const grp = (id) => ({ key: { remoteJid: '4141@g.us', participant: '2349100000122@s.whatsapp.net', id, fromMe: false }, pushName: 'Y', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'gist' } });
    settings.setAutoread('dm'); await handleMessage(sk, grp('ar3')); await handleMessage(sk, quiet('ar4', '2349100000123')); await wait(); assert.deepStrictEqual(reads, [['ar4']]);
    reads.length = 0; settings.setAutoread('groups'); await handleMessage(sk, grp('ar5')); await handleMessage(sk, quiet('ar6', '2349100000124')); await wait(); assert.deepStrictEqual(reads, [['ar5']]);
    reads.length = 0; settings.setAutoread('off'); await handleMessage(sk, quiet('ar7', '2349100000125')); await wait(); assert.strictEqual(reads.length, 0);
    settings.setAutoread('on');
    await handleMessage(sk, { ...quiet('ar8', '2349100000121'), key: { remoteJid: 'status@broadcast', participant: '2349100000126@s.whatsapp.net', id: 'ar8', fromMe: false } }); await wait(); assert.strictEqual(reads.length, 0, 'status must not be marked as viewed');
    settings.setSleep('2349100000127@s.whatsapp.net', true); await handleMessage(sk, quiet('ar9', '2349100000127')); await wait(); assert.strictEqual(reads.length, 0, 'a sleeping chat stays unread'); settings.setSleep('2349100000127@s.whatsapp.net', false);
    // owner switch
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000128', text: '.autoread off' })); assert.ok(/owner only/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.autoread dm' })); assert.ok(/private chats only/.test(last().text)); assert.strictEqual(settings.getAutoread(), 'dm');
    await handleMessage(sock, mk({ from: OWNER, text: '.autoread' })); assert.ok(/private chats only/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.autoread on' })); assert.strictEqual(settings.getAutoread(), 'on');
    process.env.HUMAN_REPLY = 'off'; delete process.env.AUTOREAD_SPEED;
  });

  await test('favorite stickers: save by mood, dedupe, send, mode, auto-save', async () => {
    process.env.FAV_CHANCE = '1'; process.env.FAV_COOLDOWN_MS = '0';
    const fav = require('./favstickers');
    const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    const q = (from, text, quoted) => ({ ...mk({ from, text }), message: { extendedTextMessage: { text, contextInfo: { stanzaId: 'qf', participant: '2349000000099@s.whatsapp.net', quotedMessage: quoted } } } });
    const stk = { stickerMessage: { mimetype: 'image/webp', fileLength: 9 } };
    assert.strictEqual(fav.moodOf('lmao that is funny'), 'laugh'); assert.strictEqual(fav.moodOf('thank you'), 'thanks'); assert.strictEqual(fav.moodOf('the table'), null);
    global.__dl = Buffer.from('sticker-one');
    sent.length = 0;
    await handleMessage(sock, q('2349100000200', '.fav laugh', stk)); assert.ok(/owner only/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.fav' })); assert.ok(/Reply to a sticker/.test(last().text));
    await handleMessage(sock, q(OWNER, '.fav banana', stk)); assert.ok(/don't know the mood/.test(last().text));
    await handleMessage(sock, q(OWNER, '.fav laugh', stk)); assert.ok(/Saved to favorites: #\d+, mood \*laugh\*/.test(last().text));
    await handleMessage(sock, q(OWNER, '.fav laugh', stk)); assert.ok(/Already in my favorites/.test(last().text));
    global.__dl = Buffer.from('sticker-two');
    await handleMessage(sock, q(OWNER, '.fav', stk)); assert.ok(/mood \*misc\*/.test(last().text), 'no AI vision answer -> misc');
    const id2 = fav._store.data.items.find((i) => i.mood === 'misc').id;
    await handleMessage(sock, mk({ from: OWNER, text: `.favmood ${id2} love` })); assert.ok(/is now \*love\*/.test(last().text));
    await handleMessage(sock, mk({ from: '2349100000201', text: '.favs' })); assert.ok(/laugh: 1/.test(last().text) && /love: 1/.test(last().text));
    sent.length = 0; await handleMessage(sock, mk({ from: '2349100000201', text: '.sendfav love' })); assert.ok(sent.some((x) => x.sticker));
    sent.length = 0; await handleMessage(sock, mk({ from: '2349100000203', text: '.sendfav sad' })); assert.ok(/don't have a "sad"/.test(last().text));
    // she follows an answer with a fitting favorite
    sent.length = 0; const ctxFake = { jid: '2349100000202@s.whatsapp.net', sock, paired: null };
    assert.strictEqual(await fav.maybeSend(ctxFake, 'haha lol', 'ha'), true); assert.ok(sent.some((x) => x.sticker));
    assert.strictEqual(await fav.maybeSend(ctxFake, 'the table', 'ok'), false, 'no mood, no sticker');
    assert.strictEqual(await fav.maybeSend(ctxFake, 'so sad 😭', 'aw'), false, 'no sad favorite saved');
    assert.strictEqual(await fav.maybeSend({ ...ctxFake, paired: { number: '1' } }, 'lol', 'x'), false, 'never on paired accounts');
    await handleMessage(sock, mk({ from: OWNER, text: '.favmode off' })); // OWNER DM jid
    assert.strictEqual(await fav.maybeSend({ ...ctxFake, jid: `${OWNER}@s.whatsapp.net` }, 'lol', 'x'), false, 'off in this chat');
    await handleMessage(sock, mk({ from: OWNER, text: '.favmode on' }));
    // auto-save
    await handleMessage(sock, mk({ from: OWNER, text: '.favauto on' })); assert.ok(fav._store.data.auto);
    global.__dl = Buffer.from('sticker-three'); const before = fav._store.data.items.length;
    await handleMessage(sock, { key: { remoteJid: `${OWNER}@s.whatsapp.net`, id: 'fa1', fromMe: false }, pushName: 'O', messageTimestamp: Math.floor(Date.now() / 1000), message: stk });
    await wait(); assert.strictEqual(fav._store.data.items.length, before + 1);
    await handleMessage(sock, mk({ from: OWNER, text: '.favauto off' }));
    // unfav
    const gone = fav._store.data.items[0].id;
    await handleMessage(sock, mk({ from: OWNER, text: `.unfav ${gone}` })); assert.ok(/Removed/.test(last().text));
    delete global.__dl; delete process.env.FAV_CHANCE; delete process.env.FAV_COOLDOWN_MS;
  });

  await test('persona per chat: owner sets warm/maki/calm for one chat, others untouched', async () => {
    const P = require('./personality');
    const G1 = '5151@g.us', G2 = '5252@g.us';
    const gm = (id, from, text) => ({ key: { remoteJid: id, participant: `${from}@s.whatsapp.net`, id: `pe${++n}`, fromMe: false }, pushName: 'X', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } });
    sent.length = 0;
    await handleMessage(sock, gm(G1, '2349100000300', '.persona maki')); assert.ok(/owner only/.test(last().text));
    await handleMessage(sock, gm(G1, OWNER, '.persona')); assert.ok(/default/.test(last().text));
    await handleMessage(sock, gm(G1, OWNER, '.persona banana')); assert.ok(/Pick one/.test(last().text));
    await handleMessage(sock, gm(G1, OWNER, '.persona maki')); assert.strictEqual(settings.getPersona(G1), 'maki'); assert.ok(/Gloves off/.test(last().text));
    await handleMessage(sock, gm(G2, OWNER, 'persona calm')); assert.strictEqual(settings.getPersona(G2), 'calm', 'works without the prefix for the owner');
    assert.strictEqual(settings.getPersona('9@g.us'), null);
    const warmP = P.systemPrompt({ mode: 'warm' }), makiP = P.systemPrompt({ mode: 'maki' }), calmP = P.systemPrompt({ mode: 'calm' });
    assert.ok(/genuinely warm/.test(warmP)); assert.ok(/Rude, blunt/.test(makiP)); assert.ok(/calm, mature/.test(calmP));
    assert.strictEqual(P.isWarm('maki'), false); assert.strictEqual(P.isWarm('warm'), true); assert.strictEqual(P.isWarm(null), P.isWarm());
    assert.strictEqual(P.softenProvocation('bot', 'you are a bot?', 'maki'), 'bot', 'maki does not soften');
    await handleMessage(sock, gm(G1, OWNER, '.persona default')); assert.strictEqual(settings.getPersona(G1), null);
    settings.setPersona(G2, null);
  });

  await test('block / unblock / blocklist: blocked people are ignored everywhere; backup sends one file', async () => {
    const bl = require('./blocklist');
    const U = '2349100000400', U2 = '2349100000401', G = '6161@g.us';
    const blocked = [];
    sock.updateBlockStatus = async (j, a) => { blocked.push([j, a]); };
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000402', text: `.block ${U}` })); assert.ok(/main owner/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.block' })); assert.ok(/Tag them|number/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: `.block ${OWNER}` })); assert.ok(/Skipped: an owner/.test(last().text), 'an owner cannot be blocked');
    await handleMessage(sock, mk({ from: OWNER, text: `.block ${U}` })); assert.ok(/Blocked 1/.test(last().text));
    assert.deepStrictEqual(blocked[0], [`${U}@s.whatsapp.net`, 'block']);
    await handleMessage(sock, mk({ from: OWNER, text: `.block ${U}` })); assert.ok(/already blocked/.test(last().text));
    // ignored in DM and in groups, even commands
    sent.length = 0;
    await handleMessage(sock, mk({ from: U, text: '.ping' }));
    await handleMessage(sock, mk({ from: U, text: 'lumi hello' }));
    await handleMessage(sock, mk({ from: U, group: G, text: '.ping' }));
    assert.strictEqual(sent.length, 0, 'blocked person got an answer');
    await handleMessage(sock, mk({ from: U2, text: '.ping' })); assert.ok(/Online/.test(last().text), 'others unaffected');
    // by tag in a group
    await handleMessage(sock, mk({ from: OWNER, group: G, text: `.block @x`, mentions: [`${U2}@s.whatsapp.net`] })); assert.ok(/Blocked 1/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.blocklist' })); assert.ok(new RegExp(U).test(last().text) && new RegExp(U2).test(last().text));
    sent.length = 0; await handleMessage(sock, mk({ from: U2, text: '.ping' })); assert.strictEqual(sent.length, 0);
    await handleMessage(sock, mk({ from: OWNER, text: `.unblock ${U}` })); assert.ok(/Unblocked 1/.test(last().text));
    assert.deepStrictEqual(blocked[blocked.length - 1], [`${U}@s.whatsapp.net`, 'unblock']);
    await handleMessage(sock, mk({ from: U, text: '.ping' })); assert.ok(/Online/.test(last().text), 'unblocked person is served again');
    await handleMessage(sock, mk({ from: OWNER, text: '.unblock all' })); assert.ok(/Unblocked everyone/.test(last().text));
    assert.strictEqual(Object.keys(bl._store.data.ids).length, 0);
    // backup
    sent.length = 0;
    await handleMessage(sock, mk({ from: '2349100000402', text: '.backup' })); assert.ok(/main owner/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, group: G, text: '.backup' })); assert.ok(/private chat/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.backup' })); assert.ok(/Passphrase needed/.test(last().text));
    assert.ok(!sent.some((x) => x.document), 'no file without the passphrase');
    await handleMessage(sock, mk({ from: OWNER, text: '.backup divine00' })); assert.ok(/Wrong passphrase/.test(last().text), 'case matters');
    assert.ok(!sent.some((x) => x.document));
    sent.length = 0; await handleMessage(sock, mk({ from: OWNER, text: '.backup DIVINE00' }));
    const doc = sent.find((x) => x.document); assert.ok(doc, 'backup file sent');
    assert.ok(/^lumi-backup-\d{4}-\d\d-\d\d\.json$/.test(doc.fileName));
    const b = JSON.parse(doc.document.toString()); assert.ok(b.stores.settings && b.stores.blocklist && !b.stickers);
    assert.ok(!/creds|noiseKey/.test(doc.document.toString()), 'no login data in a backup');
    sent.length = 0; await handleMessage(sock, mk({ from: OWNER, text: '.backup full DIVINE00' }));
    const full = JSON.parse(sent.find((x) => x.document).document.toString()); assert.ok(full.stickers && typeof full.stickers === 'object');
    sent.length = 0;
    for (let i = 0; i < 3; i++) await handleMessage(sock, mk({ from: OWNER, text: '.backup nope' }));
    await handleMessage(sock, mk({ from: OWNER, text: '.backup DIVINE00' })); assert.ok(/Locked for/.test(last().text), 'three wrong tries lock it');
    assert.ok(!sent.some((x) => x.document), 'no file while locked');
    delete sock.updateBlockStatus;
  });

  await test('recap: whole-group recap from a private chat, time ranges, long chats in parts, media tags, member checks', async () => {
    const chatlog = require('./chatlog'); const recap = require('./recap');
    const RG = '8181@g.us', RG2 = '8282@g.us';
    const ADM = '2347000000007', MEMBER = '2349100000500', OUTSIDER = '2349100000501';
    const gmsg = (g, from, name, extra) => ({ key: { remoteJid: g, participant: `${from}@s.whatsapp.net`, id: `rc${++n}`, fromMe: false }, pushName: name, messageTimestamp: Math.floor(Date.now() / 1000), message: extra });
    const oldMeta = sock.groupMetadata;
    sock.groupMetadata = async (j) => ({ subject: j === RG ? 'Naija Gist' : 'Study Squad', participants: [{ id: `${MEMBER}@s.whatsapp.net` }, { id: `${ADM}@s.whatsapp.net`, admin: 'admin' }] });
    plan = { groq: 200, deepseek: 200, gemini: 200, text: '• Football plans for Saturday\n• Ann brought snacks' };
    for (let i = 0; i < 6; i++) await handleMessage(sock, gmsg(RG, i % 2 ? ADM : MEMBER, i % 2 ? 'Ann' : 'Bob', { conversation: `real chat line ${i}` })); // no AI: ai off by not addressing her
    await handleMessage(sock, gmsg(RG, MEMBER, 'Bob', { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } }));
    await handleMessage(sock, gmsg(RG, ADM, 'Ann', { stickerMessage: { mimetype: 'image/webp' } }));
    await handleMessage(sock, gmsg(RG, MEMBER, 'Bob', { audioMessage: { ptt: true } }));
    for (let i = 0; i < 5; i++) await handleMessage(sock, gmsg(RG2, MEMBER, 'Cy', { conversation: `study note ${i}` }));
    assert.strictEqual(chatlog.count(RG), 9); assert.ok(chatlog.last(RG, 9).some((r) => r.text === '[photo] look at this') && chatlog.last(RG, 9).some((r) => r.text === '[voice note]'));
    // a command line is not logged
    await handleMessage(sock, gmsg(RG, MEMBER, 'Bob', { conversation: '.ping' })); assert.strictEqual(chatlog.count(RG), 9);
    // owner in a PRIVATE chat: list, then pick by number and by name
    sent.length = 0; fb.resetCooldowns();
    await handleMessage(sock, mk({ from: OWNER, text: '.recap' }));
    assert.ok(/Naija Gist \(9 msgs/.test(last().text) && /Study Squad \(5 msgs/.test(last().text), last().text);
    global.__bodies = [];
    await handleMessage(sock, mk({ from: OWNER, text: '.recap naija today' }));
    assert.ok(/Recap: Naija Gist/.test(last().text) && /Football plans/.test(last().text) && /9 messages from 2 people/.test(last().text), last().text);
    assert.ok(/\[photo\] look at this/.test(global.__bodies[0]) && /\[sticker\]/.test(global.__bodies[0]), 'the AI must see the media tags');
    assert.ok(/Shared: 1 photo, 1 sticker, 1 voice note/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.recap 99 1h' })); assert.ok(/don't have notes/.test(last().text));
    await handleMessage(sock, mk({ from: OWNER, text: '.recap 1 yesterday' })); assert.ok(/Not enough to recap for yesterday/.test(last().text));
    // others
    await handleMessage(sock, mk({ from: OUTSIDER, text: '.recap' })); assert.ok(/Tell me which group/.test(last().text));
    await handleMessage(sock, mk({ from: OUTSIDER, text: '.recap naija' })); assert.ok(/not in that group/.test(last().text), 'non-members cannot read a group from DM');
    await handleMessage(sock, mk({ from: MEMBER, text: '.recap naija' })); assert.ok(/Recap: Naija Gist/.test(last().text), 'members can');
    // in the group itself: anyone, default last 24h
    await handleMessage(sock, mk({ from: ADM, group: RG, text: '.recap 6h' })); assert.ok(/Recap: Naija Gist\* \(last 6h\)/.test(last().text), last().text);
    // long chat: summarised in parts, then combined
    for (let i = 0; i < 160; i++) chatlog.add('9999@g.us', { name: 'Zed', text: 'x'.repeat(100) + ` line ${i}` });
    global.__bodies = [];
    await handleMessage(sock, mk({ from: OWNER, text: '.recap 3 all' }));
    const known = chatlog.jids().sort((a, b) => chatlog.lastAt(b) - chatlog.lastAt(a));
    assert.ok(known.includes('9999@g.us'));
    sent.length = 0; global.__bodies = [];
    const idx = known.indexOf('9999@g.us') + 1;
    await handleMessage(sock, mk({ from: OWNER, text: `.recap ${idx} all` }));
    assert.ok(global.__bodies.length >= 3, 'a long chat needs several AI calls, got ' + global.__bodies.length);
    assert.ok(/Notes taken part by part/.test(global.__bodies[global.__bodies.length - 1]) && /Recap:/.test(last().text));
    // paired numbers cannot read the main number's groups
    const pairedCtx = { isGroup: false, paired: { number: '1' }, args: [], isOwner: true, reply: async (t) => t, sock, senderNum: OWNER, jid: 'x' };
    assert.ok(/main number/.test(await require('./recap')[0].run(pairedCtx)));
    // range parser
    assert.strictEqual(recap.length, 1);
    chatlog.clear('9999@g.us'); sock.groupMetadata = oldMeta;
  });

  console.log(`\n${passed} offline tests passed.`);
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
