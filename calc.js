// Calculator: .calc 2+2*5   |  .calc (12+8)/4   |  .calc 15% of 80   |  .calc 2^10   |  .calc sqrt(144)
// No eval(): the expression is parsed by a small, safe parser (numbers, + - * / % ^, brackets, a few functions).
const settings = require('./settings');

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const out = []; const re = /\s*(?:(\d+\.?\d*|\.\d+)|([a-z]+)|(.))/gy; let m;
  while ((m = re.exec(src)) && m[0] !== '') {
    if (m[1] !== undefined) out.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2]) out.push({ t: 'id', v: m[2] });
    else if (m[3] && m[3].trim()) out.push({ t: 'op', v: m[3] });
  }
  return out;
}

// Recursive descent: expr = term (+|- term)*, term = power (*|/|% power)*, power = unary (^ power)?, unary = -unary | atom
function evaluate(src) {
  const toks = tokenize(src); let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const fail = () => { throw new Error('bad expression'); };
  function expr() { let v = term(); while (peek() && (peek().v === '+' || peek().v === '-')) { const op = next().v; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  function term() {
    let v = power();
    while (peek() && ['*', '/', '%', 'x', '×', '÷'].includes(peek().v) && peek().t !== 'num') {
      const op = next().v; const r = power();
      if (op === '/' || op === '÷') { if (r === 0) throw new Error('divide by zero'); v /= r; }
      else if (op === '%') { if (r === 0) throw new Error('divide by zero'); v %= r; }
      else v *= r;
    }
    return v;
  }
  function power() { const b = unary(); if (peek() && peek().v === '^') { next(); return Math.pow(b, power()); } return b; }
  function unary() { if (peek() && peek().v === '-') { next(); return -unary(); } if (peek() && peek().v === '+') { next(); return unary(); } return atom(); }
  function atom() {
    const t = next(); if (!t) fail();
    if (t.t === 'num') { if (peek() && peek().v === '%' && !startsOperand(toks[i + 1])) { next(); return t.v / 100; } return t.v; }
    if (t.t === 'id') {
      if (t.v in CONSTS) return CONSTS[t.v];
      if (t.v in FUNCS) { if (!peek() || peek().v !== '(') fail(); next(); const a = expr(); if (!peek() || next().v !== ')') fail(); return FUNCS[t.v](a); }
      fail();
    }
    if (t.v === '(') { const v = expr(); if (!peek() || next().v !== ')') fail(); return v; }
    return fail();
  }
  const startsOperand = (t) => t && (t.t === 'num' || t.t === 'id' || t.v === '(');
  const result = expr();
  if (i < toks.length) fail();
  if (!Number.isFinite(result)) throw new Error('not a number');
  return result;
}

// "15% of 80" -> "(15/100)*80", "x" / "×" / "÷" -> * and /, thousands commas removed
function normalise(text) {
  return text.toLowerCase()
    .replace(/(\d+\.?\d*)\s*%\s*of\s*/g, '($1/100)*')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[×x](?=\s*[\d(.-])/g, '*').replace(/÷/g, '/');
}
const pretty = (n) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(12))));

module.exports = [
  {
    name: 'calc', aliases: ['calculate'], category: 'UTILITY', menu: ['calc <expression>'],
    run: async (ctx) => {
      const q = ctx.args.join(' ').trim();
      if (!q) return ctx.reply(`Give me something to work out.\nExample: ${settings.prefix()}calc (12+8)/4  or  ${settings.prefix()}calc 15% of 80`);
      if (q.length > 120) return ctx.reply('That is too long. Keep it short.');
      try { return await ctx.reply(`${q} = *${pretty(evaluate(normalise(q)))}*`); }
      catch (e) { return ctx.reply(e.message === 'divide by zero' ? "You can't divide by zero. Obviously." : "I couldn't work that out. Check the brackets and symbols."); }
    },
  },
];

// Is this whole message just a maths expression ("5+5", "(12+8)/4", "15% of 80", "sqrt(144)")?
// Used for the owner's prefix-free calculator, so it is deliberately strict: plain numbers, phone numbers,
// dates ("12-05-2024") and normal sentences are NOT maths.
const MATH_WORDS = /\b(?:sqrt|abs|round|floor|ceil|sin|cos|tan|log|ln|exp|pi|of)\b/gi;
const HAS_OPERATION = /\d\s*[+\-*\/^×÷]\s*[\d(.\-]|\d\s*x\s*[\d(.]|\d\s*%\s*(?:of\b|\d)|\b(?:sqrt|abs|round|floor|ceil|sin|cos|tan|log|ln|exp)\s*\(|\)\s*[+\-*\/^×÷x]|[+\-*\/^×÷]\s*\(/i;
function looksLikeMath(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120 || !/\d/.test(s)) return false;
  if (/^\d+(?:\s*-\s*\d+){2,}$/.test(s) && !/\s/.test(s)) return false;     // 234-801-2345, 12-05-2024
  if (/^\d{1,4}([\/.])\d{1,2}\1\d{1,4}$/.test(s)) return false;           // 12/05/2024, 1.2.3
  if (!/^[\d\s+\-*\/%^().,x×÷]+$/i.test(s.replace(MATH_WORDS, '0'))) return false;
  return HAS_OPERATION.test(s);
}
module.exports.evaluate = evaluate; module.exports.normalise = normalise; module.exports.looksLikeMath = looksLikeMath;
