// Builds the menu automatically from the registered commands.
const settings = require('./settings');
const { label, isWarm } = require('./personality');

const ORDER = ['GENERAL', 'AI SYSTEM', 'STICKER TOOLS', 'MEDIA', 'DOWNLOAD', 'PROFILE', 'GROUP TOOLS', 'GAMES', 'SOCIAL & PROFILE', 'UTILITY', 'PAIRING', 'OWNER'];

const EMOJI = {'GENERAL':'🛠','AI SYSTEM':'🧠','STICKER TOOLS':'🎭','MEDIA':'🎧','DOWNLOAD':'📥','PROFILE':'👤','GROUP TOOLS':'👥','GAMES':'🎮','UTILITY':'🧰','PAIRING':'🔗','SOCIAL & PROFILE':'💍','OWNER':'👑'};
const PER_LINE = 4;
// Layout: bold section titles with an emoji, command names only (no arguments), 4 per line.
function renderMenu(groups, cats, prefix, status, footer) {
  const out = ['*LUMI* 🤍', `_${status}_`, ''];
  for (const cat of cats) {
    const names = [...new Set(groups.get(cat).map((e) => String(e).trim().split(/\s+/)[0]))].map((n) => `${prefix}${n}`);
    out.push(`*${EMOJI[cat] || '✨'} ${cat}*`);
    for (let i = 0; i < names.length; i += PER_LINE) out.push(names.slice(i, i + PER_LINE).join('  '));
    out.push('');
  }
  out.push(`_${footer}_`);
  return out.join('\n');
}

function buildMenu(commands) {
  const prefix = settings.prefix();
  const groups = new Map();
  for (const c of commands) {
    if (c.hidden) continue;
    const cat = c.category || 'OTHER';
    if (!groups.has(cat)) groups.set(cat, []);
    for (const entry of c.menu || [c.name]) groups.get(cat).push(entry);
  }
  const total = commands.filter((c) => !c.hidden).length;
  const cats = [...ORDER.filter((c) => groups.has(c)), ...[...groups.keys()].filter((c) => !ORDER.includes(c))];

  return renderMenu(groups, cats, prefix, `Online · ${label()} · ${total} commands`, isWarm() ? "Pick a command. I'm listening." : 'Choose a command. I suppose.');
}

module.exports = { buildMenu };
