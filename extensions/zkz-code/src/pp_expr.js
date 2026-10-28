'use strict';

const SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER);

function parseCInt(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/[uUlL]+$/, '');
  if (!s) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/** JS 位运算只到 32 位。先用 BigInt，结果超出安全整数就交给上层当解析失败。 */
function bitNum(b) {
  if (b > SAFE_INT || b < -SAFE_INT) {
    const err = new Error('unsupported preprocessor syntax');
    err.code = 'ZKZ_PP_UNSUPPORTED';
    throw err;
  }
  return Number(b);
}

function evalPpExprResult(expr, macros) {
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
    const re = /\s+|('(?:\\.|[^'\\])*')|([A-Za-z_]\w*)|(0[xX][0-9a-fA-F]+[uUlL]*|0[0-7]*[uUlL]*|[1-9]\d*[uUlL]*)|(<<|>>|==|!=|<=|>=|&&|\|\||[()+\-*/%<>&|^~?:!])/g;
    let m;
    let last = 0;
    while ((m = re.exec(e)) !== null) {
      if (m.index > last && e.slice(last, m.index).trim()) {
        const err = new Error('unsupported preprocessor syntax');
        err.code = 'ZKZ_PP_UNSUPPORTED';
        throw err;
      }
      last = m.index + m[0].length;
      if (m[1] != null) tokens.push({ t: 'chr', v: m[1] });
      else if (m[2] != null) tokens.push({ t: 'id', v: m[2] });
      else if (m[3] != null) tokens.push({ t: 'num', v: m[3] });
      else if (m[4] != null) tokens.push({ t: 'op', v: m[4] });
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
    // 死分支只跳过，不求值。不认识的写法留在没走到的一侧时，整条条件仍可判定。
    function skipTernary() {
      skipOr();
      if (wantOp('?')) {
        take();
        skipTernary();
        if (wantOp(':')) take();
        skipTernary();
      }
    }
    function skipOr() {
      skipAnd();
      while (wantOp('||')) { take(); skipAnd(); }
    }
    function skipAnd() {
      skipBitOr();
      while (wantOp('&&')) { take(); skipBitOr(); }
    }
    function skipBitOr() {
      skipBitXor();
      while (wantOp('|')) { take(); skipBitXor(); }
    }
    function skipBitXor() {
      skipBitAnd();
      while (wantOp('^')) { take(); skipBitAnd(); }
    }
    function skipBitAnd() {
      skipEq();
      while (wantOp('&')) { take(); skipEq(); }
    }
    function skipEq() {
      skipRel();
      while (peek() && peek().t === 'op' && (peek().v === '==' || peek().v === '!=')) { take(); skipRel(); }
    }
    function skipRel() {
      skipShift();
      while (peek() && peek().t === 'op' && ['<=', '>=', '<', '>'].indexOf(peek().v) >= 0) { take(); skipShift(); }
    }
    function skipShift() {
      skipAdd();
      while (peek() && peek().t === 'op' && (peek().v === '<<' || peek().v === '>>')) { take(); skipAdd(); }
    }
    function skipAdd() {
      skipMul();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) { take(); skipMul(); }
    }
    function skipMul() {
      skipUnary();
      while (peek() && peek().t === 'op' && ['*', '/', '%'].indexOf(peek().v) >= 0) { take(); skipUnary(); }
    }
    function skipUnary() {
      const p = peek();
      if (p && p.t === 'op' && (p.v === '!' || p.v === '~' || p.v === '-' || p.v === '+')) {
        take();
        skipUnary();
        return;
      }
      skipPrimary();
    }
    function skipPrimary() {
      const p = peek();
      if (!p) return;
      if (p.t === 'num' || p.t === 'id' || p.t === 'chr') { take(); return; }
      if (p.t === 'op' && p.v === '(') {
        take();
        skipTernary();
        if (wantOp(')')) take();
        return;
      }
      take();
    }
    const parseTernary = () => {
      const cond = parseOr();
      if (!wantOp('?')) return cond;
      take();
      if (cond) {
        const taken = parseTernary();
        if (wantOp(':')) take();
        skipTernary();
        return taken;
      }
      skipTernary();
      if (wantOp(':')) take();
      return parseTernary();
    };
    const parseOr = () => {
      let left = parseAnd();
      while (wantOp('||')) {
        take();
        if (left) {
          skipAnd();
          left = 1;
        } else {
          left = parseAnd() ? 1 : 0;
        }
      }
      return left;
    };
    const parseAnd = () => {
      let left = parseBitOr();
      while (wantOp('&&')) {
        take();
        if (!left) {
          skipBitOr();
          left = 0;
        } else {
          left = parseBitOr() ? 1 : 0;
        }
      }
      return left;
    };
    const parseBitOr = () => {
      let left = parseBitXor();
      while (wantOp('|')) {
        take();
        left = bitNum(BigInt(left) | BigInt(parseBitXor()));
      }
      return left;
    };
    const parseBitXor = () => {
      let left = parseBitAnd();
      while (wantOp('^')) {
        take();
        left = bitNum(BigInt(left) ^ BigInt(parseBitAnd()));
      }
      return left;
    };
    const parseBitAnd = () => {
      let left = parseEq();
      while (wantOp('&')) {
        take();
        left = bitNum(BigInt(left) & BigInt(parseEq()));
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
        const right = BigInt(parseAdd());
        if (right < 0n || right >= 53n) {
          const err = new Error('unsupported preprocessor syntax');
          err.code = 'ZKZ_PP_UNSUPPORTED';
          throw err;
        }
        left = bitNum(op === '<<' ? (BigInt(left) << right) : (BigInt(left) >> right));
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
      if (p && p.t === 'op' && p.v === '~') { take(); return bitNum(~BigInt(parseUnary())); }
      if (p && p.t === 'op' && p.v === '-') { take(); return -parseUnary(); }
      if (p && p.t === 'op' && p.v === '+') { take(); return parseUnary(); }
      return parsePrimary();
    };
    const parsePrimary = () => {
      const p = peek();
      if (!p) return 0;
      if (p.t === 'chr') {
        take();
        const err = new Error('unsupported preprocessor syntax');
        err.code = 'ZKZ_PP_UNSUPPORTED';
        throw err;
      }
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
    return { ok: true, value: !!evalExpr(expr, 0) };
  } catch (e) {
    return { ok: false, value: false };
  }
}

/** 能解析时返回真假。语法不认识时返回 false，不把没算出来的条件当成 0。 */
function evalPpExpr(expr, macros) {
  const r = evalPpExprResult(expr, macros);
  return r.ok && r.value;
}

module.exports = { evalPpExpr, evalPpExprResult, parseCInt };
