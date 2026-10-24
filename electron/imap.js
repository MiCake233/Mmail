'use strict';

/**
 * Mmail · minimal IMAP client
 * ---------------------------------------------------------------------------
 * Implements only what mail alerts need: LOGIN -> ID -> SELECT INBOX -> SEARCH -> FETCH HEADERS.
 * No third-party packages; runs directly on node:net / node:tls.
 *
 * Written in-house to keep the project dependency-free while using a small subset of IMAP.
 * Handled: literal responses, multi-line responses, tagged command queue, timeouts,
 * the NetEase ID extension (163/126 answer Unsafe Login without it) and RFC 2047 subjects.
 */

const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = 20000;

/** Debugging: set MMAIL_IMAP_DEBUG=1 to log the IMAP conversation to stderr */
const DEBUG = process.env.MMAIL_IMAP_DEBUG === '1';

class ImapError extends Error {
  constructor(code, detail) {
    super(detail ? code + ' (' + detail + ')' : code);
    this.name = 'ImapError';
    this.code = code;
    this.detail = detail ? String(detail).slice(0, 240) : '';
  }
}

function quote(value) {
  const text = String(value == null ? '' : value);
  if (/[\r\n]/.test(text)) throw new ImapError('err.invalid');
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function translate(err) {
  if (err instanceof ImapError) return err;
  const code = err && err.code ? String(err.code) : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ImapError('err.network', code);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
    return new ImapError('err.network', code);
  }
  if (/CERT|SSL|TLS/i.test(code + ' ' + String(err && err.message))) return new ImapError('err.tls', code);
  return new ImapError('err.network', code || 'unknown');
}

function detailOf(result) {
  const lines = (result && result.lines) || [];
  const last = lines[lines.length - 1] || (result && result.tagged) || '';
  const match = /\[([^\]]+)\]\s*(.*)$/.exec(last);
  return (match ? match[1] + ' ' + match[2] : last).replace(/^\* /, '').slice(0, 200);
}

class ImapClient {
  constructor(options) {
    this.host = options.host;
    this.port = Number(options.port) || 993;
    this.secure = options.secure !== false;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagSeq = 0;
    this.queue = Promise.resolve();
    this.pending = null;
    this.failure = null;
    this.closing = false;

    this.greetingLines = [];
    this.greetingPending = true;
    this.greetingResolve = null;
    this.greetingReject = null;
    this.greetingTimer = null;
    this.greetingPromise = new Promise((resolve, reject) => {
      this.greetingResolve = resolve;
      this.greetingReject = reject;
    });
    /* Connection failures leave this promise unobserved; swallow it to avoid unhandled rejections */
    this.greetingPromise.catch(() => {});
  }

  /* ---------- Connection ---------- */

  connect() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        const error = translate(err);
        this.failure = error;
        reject(error);
      };
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });

      this.socket = socket;
      socket.setNoDelay(true);
      socket.setTimeout(TIMEOUT_MS);

      socket.once('error', onError);
      socket.once('timeout', () => {
        const error = new ImapError('err.timeout');
        this.failure = error;
        socket.destroy();
        reject(error);
      });

      const event = this.secure ? 'secureConnect' : 'connect';
      socket.once(event, () => {
        socket.removeListener('error', onError);
        socket.on('error', (err) => this.fail(translate(err)));
        socket.on('close', () => this.fail(new ImapError('err.network')));
        socket.on('timeout', () => {
          this.fail(new ImapError('err.timeout'));
          try {
            socket.destroy();
          } catch (err) {
            /* ignore */
          }
        });
        socket.on('data', (chunk) => this.onData(chunk));

        this.greetingTimer = setTimeout(() => {
          this.fail(new ImapError('err.timeout'));
        }, TIMEOUT_MS);

        this.greetingPromise.then(resolve, reject);
      });
    });
  }

  /* ---------- Response parsing ---------- */

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pump();
  }

  pump() {
    for (;;) {
      const index = this.buffer.indexOf('\r\n');
      if (index === -1) return;

      const lineBuffer = this.buffer.subarray(0, index);
      const literal = /\{(\d+)\+?\}$/.exec(lineBuffer.toString('latin1'));
      if (literal) {
        const size = Number(literal[1]);
        if (this.buffer.length < index + 2 + size) return; // literal not fully buffered yet
        const chunk = this.buffer.subarray(index + 2, index + 2 + size);
        this.buffer = this.buffer.subarray(index + 2 + size);
        if (this.pending) {
          /* Keep the line carrying {n}: FETCH responses put the UID there */
          this.pending.lines.push(lineBuffer.toString('utf8'));
          this.pending.literals.push(chunk);
        }
        continue;
      }

      const line = lineBuffer.toString('utf8');
      this.buffer = this.buffer.subarray(index + 2);
      this.onLine(line);
    }
  }

  onLine(line) {
    if (DEBUG) console.error('[imap<] ' + line);
    if (this.greetingPending) {
      this.greetingLines.push(line);
      if (/^\* (OK|PREAUTH)\b/i.test(line)) {
        this.finishGreeting(null);
        return;
      }
      if (/^\* (BYE|NO)\b/i.test(line)) {
        this.finishGreeting(new ImapError('err.server', line.replace(/^\* \S+ /, '')));
        return;
      }
      return;
    }

    const pending = this.pending;
    if (!pending) return;

    if (line.indexOf(pending.tag + ' ') === 0) {
      const match = /^(\S+) (OK|NO|BAD)\b/i.exec(line);
      const status = match ? match[2].toUpperCase() : 'BAD';
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve({
        status: status,
        tagged: line,
        lines: pending.lines,
        literals: pending.literals,
      });
      return;
    }

    pending.lines.push(line);
  }

  finishGreeting(error) {
    if (!this.greetingPending) return;
    this.greetingPending = false;
    clearTimeout(this.greetingTimer);
    if (error) this.greetingReject(error);
    else this.greetingResolve({ lines: this.greetingLines.slice() });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (this.greetingPending) this.finishGreeting(error);
    try {
      if (this.socket) this.socket.destroy();
    } catch (err) {
      /* ignore */
    }
  }

  /* ---------- Command queue ---------- */

  exchange(text) {
    if (this.failure) return Promise.reject(this.failure);
    const tag = 'a' + ++this.tagSeq;
    return new Promise((resolve, reject) => {
      const pending = { tag, lines: [], literals: [], resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        this.fail(new ImapError('err.timeout'));
      }, TIMEOUT_MS);
      this.pending = pending;
      try {
        if (DEBUG) console.error('[imap>] ' + tag + ' ' + text);
        this.socket.write(tag + ' ' + text + '\r\n');
      } catch (err) {
        this.pending = null;
        clearTimeout(pending.timer);
        reject(translate(err));
      }
    });
  }

  command(text) {
    const run = () => this.exchange(text);
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /* ---------- IMAP commands ---------- */

  async login(user, password) {
    const result = await this.command('LOGIN ' + quote(user) + ' ' + quote(password));
    if (result.status !== 'OK') throw new ImapError('err.auth', detailOf(result));
    return result;
  }

  /** NetEase (163 / 126 / yeah) requires an ID command before SELECT, otherwise it returns Unsafe Login. */
  async identify(clientName) {
    try {
      return await this.command(
        'ID ("name" ' + quote(clientName || 'Mmail') + ' "version" "2.0.0" "vendor" "mmail")'
      );
    } catch (err) {
      return null; // server does not support the ID extension
    }
  }

  async select(mailbox) {
    const result = await this.command('SELECT ' + quote(mailbox || 'INBOX'));
    if (result.status !== 'OK') throw new ImapError('err.imap', detailOf(result));

    const info = { exists: 0, uidNext: 0, uidValidity: 0, firstUnseen: 0 };
    result.lines.forEach((line) => {
      let match = /^\* (\d+) EXISTS/i.exec(line);
      if (match) info.exists = Number(match[1]);
      match = /\[UIDNEXT (\d+)\]/i.exec(line);
      if (match) info.uidNext = Number(match[1]);
      match = /\[UIDVALIDITY (\d+)\]/i.exec(line);
      if (match) info.uidValidity = Number(match[1]);
      match = /\[UNSEEN (\d+)\]/i.exec(line);
      if (match) info.firstUnseen = Number(match[1]);
    });
    return info;
  }

  async search(criteria) {
    const result = await this.command('UID SEARCH ' + criteria);
    if (result.status !== 'OK') throw new ImapError('err.imap', detailOf(result));

    const uids = [];
    result.lines.forEach((line) => {
      const match = /^\* SEARCH\b(.*)$/i.exec(line);
      if (!match) return;
      match[1]
        .trim()
        .split(/\s+/)
        .forEach((token) => {
          const uid = Number(token);
          if (Number.isFinite(uid) && uid > 0) uids.push(uid);
        });
    });
    return uids;
  }

  async unseen() {
    return this.search('UNSEEN');
  }

  async fetchHeaders(uids) {
    if (!uids.length) return [];
    const result = await this.command(
      'UID FETCH ' + uids.join(',') + ' (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])'
    );
    if (result.status !== 'OK') throw new ImapError('err.imap', detailOf(result));

    const items = [];
    let literalIndex = 0;
    result.lines.forEach((line) => {
      const match = /^\* \d+ FETCH \(UID (\d+)/i.exec(line);
      if (!match) return;
      let raw = '';
      if (/\{\d+\+?\}\s*$/.test(line)) {
        const literal = result.literals[literalIndex++];
        raw = literal ? literal.toString('latin1') : '';
      }
      items.push({ uid: Number(match[1]), raw });
    });
    return items;
  }

  async logout() {
    this.closing = true;
    try {
      await this.command('LOGOUT');
    } catch (err) {
      /* A closed connection is expected here */
    }
  }

  destroy() {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failure || new ImapError('err.network'));
    }
    try {
      if (this.socket) this.socket.destroy();
    } catch (err) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------------- */
/* ---------- Header decoding                                                */
/* ------------------------------------------------------------------------- */

const CHARSET_ALIAS = {
  'gb2312': 'gbk',
  'gb_2312-80': 'gbk',
  'x-gbk': 'gbk',
  'utf8': 'utf-8',
  'ks_c_5601-1987': 'euc-kr',
  'iso-8859-1': 'windows-1252',
  'ansi_x3.4-1968': 'windows-1252',
};

function normalizeCharset(charset) {
  const name = String(charset || 'utf-8')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  return CHARSET_ALIAS[name] || name;
}

function decodeBytes(buffer, charset) {
  const name = normalizeCharset(charset);
  try {
    return new TextDecoder(name, { fatal: false }).decode(buffer);
  } catch (err) {
    try {
      return buffer.toString('utf8');
    } catch (err2) {
      return '';
    }
  }
}

function qDecode(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '_') {
      bytes.push(0x20);
    } else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeWord(charset, encoding, text) {
  const body = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : qDecode(text);
  return decodeBytes(body, charset);
}

/** Restore 8-bit header text that was read through latin1 back to UTF-8. */
function restoreBytes(text) {
  if (!text || !/[^\x00-\x7f]/.test(text)) return text;
  return decodeBytes(Buffer.from(text, 'latin1'), 'utf-8');
}

function decodeWords(raw) {
  if (!raw) return '';
  const pattern = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let output = '';
  let lastIndex = 0;
  let match = pattern.exec(raw);
  while (match) {
    output += restoreBytes(raw.slice(lastIndex, match.index));
    output += decodeWord(match[1], match[2], match[3]);
    lastIndex = match.index + match[0].length;
    match = pattern.exec(raw);
  }
  output += restoreBytes(raw.slice(lastIndex));
  return output.replace(/\s+/g, ' ').trim();
}

/** `raw` is a latin1 string that preserves the original byte order. */
function parseHeaders(raw) {
  const result = { subject: '', from: '', date: '' };
  if (!raw) return result;

  const headers = {};
  const lines = String(raw).split(/\r?\n/);
  let current = null;
  lines.forEach((line) => {
    if (!line) return;
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      return;
    }
    const index = line.indexOf(':');
    if (index === -1) return;
    current = line.slice(0, index).trim().toLowerCase();
    headers[current] = line.slice(index + 1).trim();
  });

  result.subject = decodeWords(headers.subject || '');
  result.from = decodeWords(headers.from || '');
  result.date = headers.date || '';
  return result;
}

/* ------------------------------------------------------------------------- */
/* ---------- Public helpers                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Connect and read basic INBOX information (used by "Test connection").
 * @param {{email:string, secret:string, host:string, port:number, secure:boolean}} config
 */
async function probe(config) {
  const client = new ImapClient(config);
  try {
    await client.connect();
    await client.login(config.email, config.secret);
    await client.identify('Mmail');
    const info = await client.select('INBOX');
    const unseen = await client.unseen();
    return { ok: true, unread: unseen.length, uidNext: info.uidNext, exists: info.exists };
  } catch (err) {
    return { ok: false, error: toPublicError(err) };
  } finally {
    await client.logout();
    client.destroy();
  }
}

function toPublicError(err) {
  if (err instanceof ImapError) return { code: err.code, detail: err.detail };
  return { code: 'err.unknown', detail: String((err && err.message) || err).slice(0, 200) };
}

module.exports = {
  ImapClient,
  ImapError,
  probe,
  parseHeaders,
  decodeWords,
  decodeBytes,
  toPublicError,
  TIMEOUT_MS,
};
