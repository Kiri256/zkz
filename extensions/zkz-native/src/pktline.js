'use strict';

const MAX_PAYLOAD = 65516;

function hex4(n) {
  const s = n.toString(16);
  return ('0000' + s).slice(-4);
}

function encodePacket(buf) {
  const payload = buf == null ? Buffer.alloc(0) : Buffer.from(buf);
  if (payload.length > MAX_PAYLOAD) {
    throw new Error('pkt-line payload exceeds ' + MAX_PAYLOAD);
  }
  return Buffer.concat([Buffer.from(hex4(payload.length + 4), 'ascii'), payload]);
}

function encodeFlush() {
  return Buffer.from('0000', 'ascii');
}

function splitPackets(buf) {
  const out = [];
  const src = Buffer.from(buf);
  let i = 0;
  while (i < src.length) {
    if (i + 4 > src.length) break;
    const chunk = src.slice(i, src.length);
    out.push(chunk.length > MAX_PAYLOAD ? chunk.slice(0, MAX_PAYLOAD) : chunk);
    i += out[out.length - 1].length;
  }
  return out;
}

function encodeContent(buf) {
  const src = buf == null ? Buffer.alloc(0) : Buffer.from(buf);
  if (!src.length) return Buffer.alloc(0);
  const parts = [];
  for (let i = 0; i < src.length; i += MAX_PAYLOAD) {
    parts.push(encodePacket(src.slice(i, i + MAX_PAYLOAD)));
  }
  return Buffer.concat(parts);
}

class PktReader {
  constructor(stream) {
    this.stream = stream;
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.waiters = [];
    stream.on('data', (chunk) => this._push(chunk));
    stream.on('end', () => {
      this.ended = true;
      this._wake();
    });
    stream.on('error', () => {
      this.ended = true;
      this._wake();
    });
  }

  _push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._wake();
  }

  _wake() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const got = w.try();
      if (got === undefined) break;
      this.waiters.shift();
      w.resolve(got);
    }
  }

  _need(n) {
    return this.buf.length >= n;
  }

  readPacket() {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        if (this.buf.length < 4) {
          if (this.ended) return null;
          return undefined;
        }
        const lenHex = this.buf.slice(0, 4).toString('ascii');
        if (lenHex === '0000') {
          this.buf = this.buf.slice(4);
          return { flush: true, data: null };
        }
        if (lenHex === '0001' || lenHex === '0002') {
          this.buf = this.buf.slice(4);
          return { flush: false, special: lenHex, data: Buffer.alloc(0) };
        }
        const len = parseInt(lenHex, 16);
        if (!len || len < 4) {
          throw new Error('invalid pkt-line length: ' + lenHex);
        }
        if (this.buf.length < len) {
          if (this.ended) return null;
          return undefined;
        }
        const data = this.buf.slice(4, len);
        this.buf = this.buf.slice(len);
        return { flush: false, data: data };
      };
      try {
        const now = tryRead();
        if (now !== undefined) {
          resolve(now);
          return;
        }
      } catch (e) {
        reject(e);
        return;
      }
      this.waiters.push({
        resolve,
        try: tryRead
      });
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
    const text = Buffer.concat(parts).toString('utf8');
    const headers = Object.create(null);
    for (const line of text.split('\n')) {
      const s = line.replace(/\r$/, '');
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq < 0) {
        headers[s] = true;
        continue;
      }
      headers[s.slice(0, eq)] = s.slice(eq + 1);
    }
    return { eof: eof, headers: headers, raw: text };
  }

  async readBinaryUntilFlush() {
    const { eof, parts } = await this.readUntilFlush();
    return { eof: eof, data: Buffer.concat(parts) };
  }
}

function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => {
      if (err) reject(err);
      else if (ok !== false) resolve();
    });
    if (ok === false) {
      stream.once('drain', resolve);
    }
  });
}

module.exports = {
  MAX_PAYLOAD,
  encodePacket,
  encodeFlush,
  encodeContent,
  splitPackets,
  PktReader,
  writeAll
};
