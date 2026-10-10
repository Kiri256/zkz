'use strict';

const MAX_PAYLOAD = 65516;
const INPUT_HIGH_WATER = 4 * (MAX_PAYLOAD + 4);
const INPUT_LOW_WATER = MAX_PAYLOAD + 4;

function hex4(n) {
  const s = n.toString(16);
  return ('0000' + s).slice(-4);
}

function encodePacket(buf) {
  const payload = buf == null ? Buffer.alloc(0) : (Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  if (payload.length > MAX_PAYLOAD) {
    throw new Error('pkt-line payload exceeds ' + MAX_PAYLOAD);
  }
  return Buffer.concat([Buffer.from(hex4(payload.length + 4), 'ascii'), payload]);
}

function encodeFlush() {
  return Buffer.from('0000', 'ascii');
}

function encodeContent(buf) {
  const src = buf == null ? Buffer.alloc(0) : (Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  if (!src.length) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(src.length + 4 * Math.ceil(src.length / MAX_PAYLOAD));
  let offset = 0;
  for (let i = 0; i < src.length; i += MAX_PAYLOAD) {
    const length = Math.min(MAX_PAYLOAD, src.length - i);
    out.write(hex4(length + 4), offset, 4, 'ascii');
    src.copy(out, offset + 4, i, i + length);
    offset += length + 4;
  }
  return out;
}

class PktReader {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.buffered = 0;
    this.paused = false;
    this.ended = false;
    this.error = null;
    this.waiters = [];
    stream.on('data', (chunk) => this._push(chunk));
    stream.on('end', () => {
      this.ended = true;
      this._wake();
    });
    stream.on('error', (error) => {
      this.error = error;
      this.ended = true;
      this.chunks = [];
      this.head = this.offset = this.buffered = 0;
      this._wake();
    });
  }

  _push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (!this.paused && this.buffered >= INPUT_HIGH_WATER) {
        this.paused = true;
        this.stream.pause();
      }
    }
    this._wake();
  }

  _wake() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      let got;
      try { got = w.try(); } catch (e) {
        this.waiters.shift();
        w.reject(e);
        continue;
      }
      if (got === undefined) break;
      this.waiters.shift();
      w.resolve(got);
    }
  }

  _take(n) {
    if (!n) return Buffer.alloc(0);
    const first = this.chunks[this.head];
    let result;
    if (first.length - this.offset >= n) {
      result = first.subarray(this.offset, this.offset + n);
      this.offset += n;
    } else {
      result = Buffer.allocUnsafe(n);
      let copied = 0;
      while (copied < n) {
        const chunk = this.chunks[this.head];
        const count = Math.min(n - copied, chunk.length - this.offset);
        chunk.copy(result, copied, this.offset, this.offset + count);
        copied += count;
        this.offset += count;
        if (this.offset === chunk.length) {
          this.chunks[this.head++] = null;
          this.offset = 0;
        }
      }
    }
    if (this.chunks[this.head] && this.offset === this.chunks[this.head].length) {
      this.chunks[this.head++] = null;
      this.offset = 0;
    }
    this.buffered -= n;
    if (this.paused && this.buffered <= INPUT_LOW_WATER) {
      this.paused = false;
      this.stream.resume();
    }
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return result;
  }

  readPacket() {
    return new Promise((resolve, reject) => {
      let lenHex = null;
      const tryRead = () => {
        if (this.error) throw this.error;
        if (lenHex === null) {
          if (this.buffered < 4) {
            if (this.ended && this.buffered) throw new Error('truncated pkt-line header');
            return this.ended ? null : undefined;
          }
          lenHex = this._take(4).toString('ascii');
        }
        if (lenHex === '0000') {
          return { flush: true, data: null };
        }
        if (lenHex === '0001' || lenHex === '0002') {
          return { flush: false, special: lenHex, data: Buffer.alloc(0) };
        }
        const len = parseInt(lenHex, 16);
        if (!/^[0-9a-f]{4}$/i.test(lenHex) || len < 4 || len > MAX_PAYLOAD + 4) {
          throw new Error('invalid pkt-line length: ' + lenHex);
        }
        if (this.buffered < len - 4) {
          if (this.ended) throw new Error('truncated pkt-line payload');
          return undefined;
        }
        const data = this._take(len - 4);
        return { flush: false, data: data };
      };
      this.waiters.push({
        resolve,
        reject,
        try: tryRead
      });
      this._wake();
    });
  }

  async readUntilFlush() {
    const parts = [];
    for (; ;) {
      const pkt = await this.readPacket();
      if (!pkt) return { eof: true, parts: parts };
      if (pkt.flush) return { eof: false, parts: parts };
      if (pkt.data && pkt.data.length) parts.push(pkt.data);
    }
  }

  async readTextHeaders() {
    const { eof, parts } = await this.readUntilFlush();
    // pkt-line 协议：一包 = 一条逻辑记录。不能把所有包拼接后再按 \n 切——
    // 有的 git 客户端（如 Cursor 内置 git）发的负载不带尾随 \n，拼接后相邻
    // header 会黏成一个（git-filter-client + version=2 → git-filter-clientversion=2）。
    // 逐包解析；同时兼容"一个包内含多条 \n 分隔 header"的实现。
    const headers = Object.create(null);
    const lines = [];
    for (const part of parts) {
      const s = part.toString('utf8');
      for (const one of s.split('\n')) {
        const line = one.replace(/\r$/, '');
        if (!line) continue;
        lines.push(line);
      }
    }
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) {
        headers[line] = true;
        continue;
      }
      headers[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { eof: eof, headers: headers, raw: lines.join('\n') };
  }

  async readBinaryUntilFlush() {
    const { eof, parts } = await this.readUntilFlush();
    return { eof: eof, data: Buffer.concat(parts) };
  }
}

function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    let returned = false;
    let flushed = false;
    let drained = false;
    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.removeListener('drain', onDrain);
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => onError(new Error('pkt-line output closed before write completed'));
    const finish = () => {
      if (returned && flushed && drained) { cleanup(); resolve(); }
    };
    const onDrain = () => { drained = true; finish(); };
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.once('drain', onDrain);
    try {
      const accepted = stream.write(buf, (err) => {
        if (err) {
          // Writable emits error after its callback; keep the error listener
          // until that event to prevent an unhandled stream error.
          reject(err);
          return;
        }
        flushed = true;
        finish();
      });
      if (accepted !== false) drained = true;
      returned = true;
      finish();
    } catch (err) {
      onError(err);
    }
  });
}

async function writeContent(stream, body) {
  const src = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  for (let offset = 0; offset < src.length; offset += MAX_PAYLOAD) {
    await writeAll(stream, encodePacket(src.subarray(offset, offset + MAX_PAYLOAD)));
  }
}

module.exports = {
  MAX_PAYLOAD,
  encodePacket,
  encodeFlush,
  encodeContent,
  PktReader,
  writeAll,
  writeContent
};
