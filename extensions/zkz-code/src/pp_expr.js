'use strict';

function parseCInt(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/[uUlL]+$/, '');
  if (!s) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

function evalPpExpr(expr, macros) {
  const env = macros || {};
  const evalExpr = (e0, depth) => {
    if (depth > 32) return 0;
    let e = String(e0 || '');
    e = e.replace(/\/\*.*?\*\//g, ' ');
    e = e.replace(/\/\/.*$/, '').trim();
    if (!e) return 0;
    e = e.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => ((n in env) ? '1' : '0'));
    e = e.replace(/defined\s+([A-Za-z_]\w*)/g, (_, n) => ((n in env) ? '1' : '0'));
    /** @type {{ t: string, v: string }[]} */
    const tokens = [];
    const re = /\s+|([A-Za-z_]\w*)|(0[xX][0-9a-fA-F]+[uUlL]*|0[0-7]*[uUlL]*|[1-9]\d*[uUlL]*)|(<<|>>|==|!=|<=|>=|&&|\|\||[()+\-*/%<>&|^~?:!])/g;
    let m;
    let last = 0;
    while ((m = re.exec(e)) !== null) {
      if (m.index > last && e.slice(last, m.index).trim()) {
        const err = new Error('unsupported preprocessor syntax');
        err.code = 'ZKZ_PP_UNSUPPORTED';
        throw err;
      }
      last = m.index + m[0].length;
      if (m[1] != null) tokens.push({ t: 'id', v: m[1] });
      else if (m[2] != null) tokens.push({ t: 'num', v: m[2] });
      else if (m[3] != null) tokens.push({ t: 'op', v: m[3] });
    }
    if (e.slice(last).trim()) {
      const err = new Error('unsupported preprocessor syntax');
      err.code = 'ZKZ_PP_UNSUPPORTED';
      throw err;
    }
    let i = 0;
    const peek = () => (i < tokens.length ? tokens[i] : null);
    const take = () => tokens[i++];
    const wantOp = (v) => peek() && peek().t === 'op' && peek().v === v;
    const expandId = (name) => {
      if (!(name in env)) return 0;
      const v = env[name];
      if (v === '' || v == null) return 1;
      const s = String(v).trim();
      const n = parseCInt(s);
      if (n != null) return n;
      if (/^\(\s*-?\d+\s*\)$/.test(s)) return parseInt(s.replace(/[()]/g, '').trim(), 10);
      const inner = parseCInt(s.replace(/^\(|\)$/g, '').trim());
      if (inner != null && /^\(.*\)$/.test(s)) return inner;
      return evalExpr(s, depth + 1);
    };
    const parseTernary = () => {
      const cond = parseOr();
      if (wantOp('?')) {
        take();
        const a = parseTernary();
        if (wantOp(':')) take();
        const b = parseTernary();
        return cond ? a : b;
      }
      return cond;
    };
    const parseOr = () => {
      let left = parseAnd();
      while (wantOp('||')) {
        take();
        left = (left || parseAnd()) ? 1 : 0;
      }
      return left;
    };
    const parseAnd = () => {
      let left = parseBitOr();
      while (wantOp('&&')) {
        take();
        left = (left && parseBitOr()) ? 1 : 0;
      }
      return left;
    };
    const parseBitOr = () => {
      let left = parseBitXor();
      while (wantOp('|')) {
        take();
        left = left | parseBitXor();
      }
      return left;
    };
    const parseBitXor = () => {
      let left = parseBitAnd();
      while (wantOp('^')) {
        take();
        left = left ^ parseBitAnd();
      }
      return left;
    };
    const parseBitAnd = () => {
      let left = parseEq();
      while (wantOp('&')) {
        take();
        left = left & parseEq();
      }
      return left;
    };
    const parseEq = () => {
      let left = parseRel();
      while (peek() && peek().t === 'op' && (peek().v === '==' || peek().v === '!=')) {
        const op = take().v;
        const right = parseRel();
        left = (op === '==' ? left === right : left !== right) ? 1 : 0;
      }
      return left;
    };
    const parseRel = () => {
      let left = parseShift();
      while (peek() && peek().t === 'op' && ['<=', '>=', '<', '>'].indexOf(peek().v) >= 0) {
        const op = take().v;
        const right = parseShift();
        if (op === '<=') left = left <= right ? 1 : 0;
        else if (op === '>=') left = left >= right ? 1 : 0;
        else if (op === '<') left = left < right ? 1 : 0;
        else left = left > right ? 1 : 0;
      }
      return left;
    };
    const parseShift = () => {
      let left = parseAdd();
      while (peek() && peek().t === 'op' && (peek().v === '<<' || peek().v === '>>')) {
        const op = take().v;
        const right = parseAdd();
        left = op === '<<' ? (left << right) : (left >> right);
      }
      return left;
    };
    const parseAdd = () => {
      let left = parseMul();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = take().v;
        const right = parseMul();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };
    const parseMul = () => {
      let left = parseUnary();
      while (peek() && peek().t === 'op' && ['*', '/', '%'].indexOf(peek().v) >= 0) {
        const op = take().v;
        const right = parseUnary();
        if (op === '*') left = left * right;
        else if (op === '/') left = right ? Math.trunc(left / right) : 0;
        else left = right ? (left % right) : 0;
      }
      return left;
    };
    const parseUnary = () => {
      const p = peek();
      if (p && p.t === 'op' && p.v === '!') { take(); return parseUnary() ? 0 : 1; }
      if (p && p.t === 'op' && p.v === '~') { take(); return ~parseUnary(); }
      if (p && p.t === 'op' && p.v === '-') { take(); return -parseUnary(); }
      if (p && p.t === 'op' && p.v === '+') { take(); return parseUnary(); }
      return parsePrimary();
    };
    const parsePrimary = () => {
      const p = peek();
      if (!p) return 0;
      if (p.t === 'num') {
        take();
        const n = parseCInt(p.v);
        return n == null ? 0 : n;
      }
      if (p.t === 'id') { take(); return expandId(p.v); }
      if (p.t === 'op' && p.v === '(') {
        take();
        const v = parseTernary();
        if (wantOp(')')) take();
        return v;
      }
      take();
      return 0;
    };
    const value = parseTernary();
    if (peek()) {
      const err = new Error('unsupported preprocessor syntax');
      err.code = 'ZKZ_PP_UNSUPPORTED';
      throw err;
    }
    return value;
  };
  try {
    return !!evalExpr(expr, 0);
  } catch (e) {
    return false;
  }
}

module.exports = { evalPpExpr, parseCInt };
