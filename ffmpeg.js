// ffmpeg helper (used for animated sticker -> video). Sets FFMPEG_PATH
// so wa-sticker-formatter can find the same binary.
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) { try { ffmpegPath = require('ffmpeg-static'); } catch (_) {} }
// No bundled ffmpeg-static? Use an ffmpeg that is installed on the machine, if there is one.
if (!ffmpegPath) {
  try { if (require('child_process').spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0) ffmpegPath = 'ffmpeg'; } catch (_) {}
}
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

async function gifToMp4(buf) {
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-'));
  const inp = path.join(dir, 'in.gif');
  const out = path.join(dir, 'out.mp4');
  try {
    await fs.writeFile(inp, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inp, '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
// Any video / voice note / audio -> MP3 (128 kbps stereo).
async function toMp3(buf) {
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-'));
  const inp = path.join(dir, 'in.bin');
  const out = path.join(dir, 'out.mp3');
  try {
    await fs.writeFile(inp, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inp, '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', out]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
// Any audio -> a WhatsApp voice note (mono OGG/Opus, 48 kHz). WhatsApp only shows the round "voice" bubble for this format.
async function toVoiceNote(buf) {
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-'));
  const inp = path.join(dir, 'in.bin');
  const out = path.join(dir, 'out.ogg');
  try {
    await fs.writeFile(inp, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inp, '-vn', '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-application', 'voip', out]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
module.exports = { gifToMp4, toMp3, toVoiceNote };
