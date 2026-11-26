// .persona <warm|maki|calm|default>: the owner picks how Lumi talks in THIS chat.
const settings = require('./settings');
const { MODES, label } = require('./personality');
const config = require('./config');

const INFO = {
  warm: 'warm and kind, bites back only when provoked',
  maki: 'blunt, rude and unbothered with everyone except owners',
  calm: 'calm, mature and nonchalant',
};
module.exports = [
  {
    name: 'persona', aliases: ['personality', 'mode'], category: 'AI SYSTEM', menu: ['persona'], ownerOnly: true,
    run: async (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      const now = settings.getPersona(ctx.jid);
      if (!a) {
        return ctx.reply(`In this chat I'm *${now || config.personality}*${now ? '' : ' (the default)'}: ${INFO[now || (MODES.includes(config.personality) ? config.personality : 'warm')]}.\n\nChange it: ${settings.prefix()}persona warm | maki | calm\nBack to default: ${settings.prefix()}persona default`);
      }
      if (['default', 'reset', 'off'].includes(a)) { settings.setPersona(ctx.jid, null); return ctx.reply(`Back to my default personality here (${config.personality}).`); }
      if (!MODES.includes(a)) return ctx.reply(`Pick one: ${MODES.join(', ')} (or "default").`);
      settings.setPersona(ctx.jid, a);
      return ctx.reply({ warm: "Okay. Warm it is. I'll be nice here.", maki: "Fine. Gloves off in this chat.", calm: "Alright. Calm and quiet here." }[a]);
    },
  },
];
