// .play <song>  -> finds the track, then sends the FULL song as audio (not just a preview).
//  1. iTunes Search API: artist, title, cover art, the real song length and a 30-second preview.
//  2. YouTube search (no key needed) picks the video whose length matches the song best.
//  3. The cobalt server from .dl (COBALT_API_URL) turns that video into an mp3, which Lumi sends.
// Without COBALT_API_URL, or if anything fails, she falls back to the 30-second preview + links.
// Songs longer than PLAY_MAX_SECONDS (default 600 = 10 min) are not sent in full.
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');
const { request } = require('./http');
const dl = require('./download');

const MAX_SECONDS = () => parseInt(process.env.PLAY_MAX_SECONDS, 10) || 600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BAD_WORDS = /\b(cover|karaoke|instrumental|remix|slowed|sped up|reverb|8d|nightcore|reaction|tutorial|lesson)\b/i;

// "3:45" / "1:02:10" -> seconds
const toSeconds = (t) => String(t || '').split(':').map(Number).reduce((a, n) => a * 60 + (Number.isFinite(n) ? n : 0), 0);

// Pull the video results out of YouTube's search page.
function parseYoutube(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html) || /ytInitialData"\]\s*=\s*(\{.*?\});/s.exec(html);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({
        id: v.videoId,
        title: (v.title && v.title.runs && v.title.runs.map((r) => r.text).join('')) || '',
        channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '',
        seconds: toSeconds(v.lengthText && v.lengthText.simpleText), // 0 = live stream
      });
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return out;
}

// Best match: right length, not a cover/remix/karaoke (unless asked for), prefers the artist's own channel.
function pickVideo(videos, { query = '', artist = '', targetSeconds = 0, maxSeconds = 600 }) {
  let best = null;
  for (const v of videos) {
    if (!v.seconds || v.seconds < 60 || v.seconds > maxSeconds) continue;
    let score = targetSeconds ? Math.abs(v.seconds - targetSeconds) : Math.abs(v.seconds - 210);
    if (targetSeconds && Math.abs(v.seconds - targetSeconds) > 25) score += 500; // wrong version
    if (BAD_WORDS.test(v.title) && !BAD_WORDS.test(query)) score += 1000;
    if (artist && v.channel.toLowerCase().includes(artist.toLowerCase().split(/[,&]/)[0].trim())) score -= 20;
    if (/official/i.test(v.title) || /topic$/i.test(v.channel)) score -= 10;
    if (!best || score < best.score) best = { ...v, score };
  }
  return best && best.score < 500 ? best : null;
}

async function searchYoutube(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`;
  const html = await request(url, { as: 'text', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, timeoutMs: 15000 });
  return parseYoutube(html);
}

const busy = new Set();

module.exports = [
  {
    name: 'play', category: 'MEDIA', menu: ['play'],
    run: async (ctx) => {
      const q = ctx.argText;
      if (!q) return ctx.reply(`Tell me what to look for. Example: ${settings.prefix()}play artist - song`);
      if (busy.has(ctx.jid)) return ctx.reply('Still working on the last song. One at a time.');
      busy.add(ctx.jid);
      try { await play(ctx, q); } finally { busy.delete(ctx.jid); }
    },
  },
];

async function play(ctx, q) {
  await ctx.sock.sendMessage(ctx.jid, { react: { text: '🎧', key: ctx.msg.key } }).catch(() => {});

  // 1) song info (optional: if iTunes finds nothing we still try YouTube with the raw text)
  let t = null;
  try {
    const data = await request(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=1&country=${config.music.country}`, { timeoutMs: 15000 });
    t = data && data.results && data.results[0];
  } catch (e) { log.warn('iTunes search failed:', e.message); }

  const title = t ? t.trackName : q;
  const artist = t ? t.artistName : '';
  const target = t && t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : 0;
  const maxSeconds = MAX_SECONDS();

  // 2) find the full audio
  let audio = null; let why = '';
  if (target > maxSeconds) why = `That one is ${Math.round(target / 60)} minutes long, over my ${Math.round(maxSeconds / 60)}-minute limit.`;
  else {
    try {
      const video = pickVideo(await searchYoutube(`${artist} ${title} audio`.trim()), { query: q, artist, targetSeconds: target, maxSeconds });
      if (!video) why = "I couldn't find a good full version of that song.";
      else {
        const [f] = await dl.resolveLink(`https://www.youtube.com/watch?v=${video.id}`, true);
        const file = await dl.fetchFile(f.url);
        if (file.type === 'text/html') throw new Error('not audio');
        audio = { buf: file.buf, mimetype: file.type.startsWith('audio/') ? file.type : 'audio/mpeg', video };
      }
    } catch (e) {
      log.warn(`play: full song failed: ${e.message}`);
      why = e.noService
        ? "Full songs need a downloader set up on my server (COBALT_API_URL)."
        : e.message === 'too big' ? "That song's file is too big to send." : "Couldn't download the full song right now.";
    }
  }

  // 3) the card: cover, names, links
  const name = t ? `*${t.trackName}*\n${t.artistName}${t.collectionName ? `\nAlbum: ${t.collectionName}` : ''}` : `*${q}*`;
  const links = t ? `\n\nListen: ${t.trackViewUrl}` : '';
  const caption = `${name}${links}${audio ? '' : `\n\n${why} ${t && t.previewUrl ? 'Sending a 30-second preview instead.' : ''}`}`.trim();
  if (t && t.artworkUrl100) {
    try {
      const img = await request(t.artworkUrl100.replace('100x100', '600x600'), { as: 'buffer', timeoutMs: 15000 });
      await ctx.sock.sendMessage(ctx.jid, { image: img, caption }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply(caption); }
  } else await ctx.reply(caption);

  // 4) the song
  if (audio) {
    try { return await ctx.sock.sendMessage(ctx.jid, { audio: audio.buf, mimetype: audio.mimetype, ptt: false }, { quoted: ctx.msg }); }
    catch (e) { log.warn('play: sending audio failed:', e.message); }
  }
  if (t && t.previewUrl) {
    try {
      const preview = await request(t.previewUrl, { as: 'buffer', timeoutMs: 20000 });
      await ctx.sock.sendMessage(ctx.jid, { audio: preview, mimetype: 'audio/mp4', ptt: false }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply("The preview wouldn't load either. Try the link above."); }
  } else if (!audio) await ctx.reply(t ? "No audio available. Use the link above." : "I couldn't find that one. Try 'artist - song'.");
}
module.exports.parseYoutube = parseYoutube;
module.exports.pickVideo = pickVideo;
