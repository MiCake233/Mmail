#!/usr/bin/env node
/**
 * Mmail · IMAP client regression test
 * ---------------------------------------------------------------------------
 * Starts a local fake IMAP server (plain TCP, no real mailbox) and verifies:
 *   1. the first check stores a baseline and produces no alert;
 *   2. incremental checks find only new UIDs and decode subject / sender;
 *   3. RFC 2047 decoding for UTF-8, GBK, Q-encoding and folded headers;
 *   4. wrong credentials surface err.auth;
 *   5. an unreachable host surfaces err.network or err.timeout.
 *
 * Usage: npm run test:imap
 */

import net from 'node:net';
import assert from 'node:assert/strict';

import imapModule from '../electron/imap.js';
import mailcheckModule from '../electron/mailcheck.js';
import clockModule from '../electron/clock.js';

const { parseHeaders, decodeWords, parseProxy, formatProxyRule, redactProxyUrl, isValidHost } = imapModule;
const { checkMailbox } = mailcheckModule;
const { normalizeClock } = clockModule;

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const UTF8_SUBJECT = Buffer.from('【测试】你好，世界', 'utf8').toString('base64');
const UTF8_FROM_NAME = Buffer.from('张三', 'utf8').toString('base64');
const GBK_SUBJECT = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]).toString('base64'); // "测试" in GBK

const HEADERS = {
  10:
    'From: =?UTF-8?B?' + UTF8_FROM_NAME + '?= <zhangsan@example.com>\r\n' +
    'Subject: =?UTF-8?B?' + UTF8_SUBJECT + '?=\r\n' +
    'Date: Tue, 1 Oct 2024 10:00:00 +0800\r\n\r\n',
  11: 'From: Someone <someone@example.com>\r\nSubject: =?GBK?B?' + GBK_SUBJECT + '?=\r\n\r\n',
  12:
    'From: folded@example.com\r\n' +
    'Subject: hello =?UTF-8?Q?=E4=BD=A0=E5=A5=BD?=\r\n' +
    '  world\r\n\r\n',
};

const SERVER_UIDS = [10, 11, 12];

const serverState = {
  uids: SERVER_UIDS.slice(),
  uidNext: 13,
  uidValidity: 42,
  sendUidNext: true,
  hangCommand: '',
  hugeLiteral: false,
  uidAtEnd: false,
};

function rememberState() {
  return {
    uids: serverState.uids.slice(),
    uidNext: serverState.uidNext,
    uidValidity: serverState.uidValidity,
    sendUidNext: serverState.sendUidNext,
    hangCommand: serverState.hangCommand,
    hugeLiteral: serverState.hugeLiteral,
    uidAtEnd: serverState.uidAtEnd,
  };
}

function restoreState(saved) {
  serverState.uids = saved.uids.slice();
  serverState.uidNext = saved.uidNext;
  serverState.uidValidity = saved.uidValidity;
  serverState.sendUidNext = saved.sendUidNext;
  serverState.hangCommand = saved.hangCommand;
  serverState.hugeLiteral = saved.hugeLiteral;
  serverState.uidAtEnd = saved.uidAtEnd;
}

async function withServer(patch, fn) {
  const saved = rememberState();
  if (patch.uids) serverState.uids = patch.uids.slice();
  Object.assign(serverState, patch, patch.uids ? { uids: serverState.uids } : {});
  try {
    await fn();
  } finally {
    restoreState(saved);
  }
}

/* Minimal SOCKS5 proxy (no auth) used to verify the proxied IMAP path. */
function startSocksProxy() {
  const server = net.createServer((client) => {
    client.on('error', () => {});
    client.once('data', (greeting) => {
      if (greeting[0] !== 0x05) {
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', (request) => {
        let cursor = 4;
        const hostLength = request[cursor];
        const host = request.subarray(cursor + 1, cursor + 1 + hostLength).toString('utf8');
        cursor += 1 + hostLength;
        const port = request.readUInt16BE(cursor);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* Fake server                                                        */
/* ------------------------------------------------------------------ */

function startFakeServer() {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 ID] fake imap ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line) handleLine(line, socket, requests);
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function handleLine(line, socket, requests) {
  const match = /^(\S+) (.+)$/.exec(line);
  if (!match) return;

  const tag = match[1];
  let verb = '';
  let rest = match[2];
  requests.push(rest);

  let command = rest;
  const inner = /^(\S+)(?: (.*))?$/.exec(rest);
  if (inner) {
    verb = inner[1].toUpperCase();
    rest = inner[2] || '';
    if (verb === 'UID') {
      const after = /^(\S+)(?: (.*))?$/.exec(rest);
      if (after) {
        verb = after[1].toUpperCase();
        command = after[1] + ' ' + (after[2] || '');
        rest = after[2] || '';
      }
    }
  }

  switch (verb) {
    case 'LOGIN':
      if (rest.indexOf('"wrong-code"') !== -1) {
        socket.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
      } else {
        socket.write('* CAPABILITY IMAP4rev1 ID\r\n');
        socket.write(tag + ' OK LOGIN completed\r\n');
      }
      break;

    case 'ID':
      socket.write('* ID ("name" "fake")\r\n');
      socket.write(tag + ' OK ID completed\r\n');
      break;

    case 'SELECT':
      if (serverState.hangCommand === 'SELECT') return;
      socket.write('* ' + Math.max(serverState.uids.length, 1) + ' EXISTS\r\n');
      socket.write('* OK [UIDVALIDITY ' + serverState.uidValidity + '] UIDs valid\r\n');
      if (serverState.sendUidNext) {
        socket.write('* OK [UIDNEXT ' + serverState.uidNext + '] Predicted next UID\r\n');
      }
      socket.write('* OK [UNSEEN 10] First unseen\r\n');
      socket.write(tag + ' OK [READ-WRITE] SELECT completed\r\n');
      break;

    case 'SEARCH': {
      if (/^UNSEEN/i.test(rest)) {
        socket.write('* SEARCH 10 11\r\n');
      } else {
        const range = /^UID (\d+):\*/i.exec(rest);
        if (range) {
          const lower = Number(range[1]);
          const list = serverState.uids.filter((uid) => uid >= lower);
          /* IMAP semantics: n:* always yields at least the highest UID. */
          const fallback = serverState.uids.length ? String(serverState.uids[serverState.uids.length - 1]) : '';
          socket.write('* SEARCH ' + (list.length ? list.join(' ') : fallback) + '\r\n');
        } else {
          socket.write('* SEARCH ' + serverState.uids.join(' ') + '\r\n');
        }
      }
      socket.write(tag + ' OK SEARCH completed\r\n');
      break;
    }

    case 'FETCH': {
      if (/^\*\s+\(UID\)\s*$/i.test(rest.trim())) {
        const last = serverState.uids[serverState.uids.length - 1];
        if (last) socket.write('* 1 FETCH (UID ' + last + ')\r\n');
        socket.write(tag + ' OK FETCH completed\r\n');
        break;
      }
      if (serverState.hugeLiteral) {
        socket.write('* 1 FETCH (UID 1 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {999999999}\r\n');
        socket.write(tag + ' OK FETCH completed\r\n');
        break;
      }
      const uidList = (/(\d+(?:,\d+)*)/.exec(rest) || [, ''])[1];
      const uids = uidList ? uidList.split(',').map(Number) : [];
      uids.forEach((uid, index) => {
        const header = HEADERS[uid] || 'Subject: (none)\r\n\r\n';
        const literal = Buffer.from(header, 'latin1');
        if (serverState.uidAtEnd) {
          socket.write('* ' + (index + 1) + ' FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {' + literal.length + '}\r\n');
          socket.write(literal);
          socket.write(' UID ' + uid + ')\r\n');
        } else {
          socket.write('* ' + (index + 1) + ' FETCH (UID ' + uid + ' BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {' + literal.length + '}\r\n');
          socket.write(literal);
          socket.write(')\r\n');
        }
      });
      socket.write(tag + ' OK FETCH completed\r\n');
      break;
    }

    case 'LOGOUT':
      socket.write('* BYE bye\r\n');
      socket.write(tag + ' OK LOGOUT completed\r\n');
      break;

    case 'CAPABILITY':
      socket.write('* CAPABILITY IMAP4rev1 ID\r\n');
      socket.write(tag + ' OK CAPABILITY completed\r\n');
      break;

    default:
      socket.write(tag + ' BAD unknown command: ' + command + '\r\n');
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('[ok]   ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('[fail] ' + name + ' -> ' + error.message);
  }
}

/* Header decoding */

await test('RFC 2047: UTF-8 base64 subject and sender', () => {
  const headers = parseHeaders(HEADERS[10]);
  assert.equal(headers.subject, '【测试】你好，世界');
  assert.match(headers.from, /张三/);
  assert.match(headers.from, /zhangsan@example\.com/);
});

await test('RFC 2047: GBK base64 subject', () => {
  const headers = parseHeaders(HEADERS[11]);
  assert.equal(headers.subject, '测试');
});

await test('RFC 2047: Q-encoded, folded subject', () => {
  const headers = parseHeaders(HEADERS[12]);
  assert.equal(headers.subject, 'hello 你好 world');
});

await test('decodeWords: plain text and empty input', () => {
  assert.equal(decodeWords('plain subject'), 'plain subject');
  assert.equal(decodeWords(''), '');
});

await test('quiet hours keep a real HH:MM and reject the broken literal pattern', () => {
  assert.equal(normalizeClock('09:30', '22:00'), '09:30');
  assert.equal(normalizeClock('22:00', '22:00'), '22:00');
  assert.equal(normalizeClock('08:00', '08:00'), '08:00');
  assert.equal(normalizeClock('dd:dd', '22:00'), '22:00');
  assert.equal(normalizeClock('25:00', '22:00'), '22:00');
  assert.equal(normalizeClock('09:60', '08:00'), '08:00');
  assert.equal(normalizeClock('', '22:00'), '22:00');
});

await test('hosts reject control characters and accept normal mail servers', () => {
  assert.equal(isValidHost('imap.qq.com'), true);
  assert.equal(isValidHost('127.0.0.1'), true);
  assert.equal(isValidHost('::1'), true);
  assert.equal(isValidHost('[::1]'), true);
  assert.equal(isValidHost('localhost'), true);
  assert.equal(isValidHost('imap.qq.com\r\nLOGIN'), false);
  assert.equal(isValidHost('imap.qq.com/extra'), false);
  assert.equal(isValidHost(''), false);
});

await test('IPv6 proxy hosts are bare for net.connect and bracketed for Chromium', () => {
  const parsed = parseProxy('socks5://[::1]:1080');
  assert.equal(parsed.host, '::1');
  assert.equal(parsed.port, 1080);
  assert.equal(formatProxyRule(parsed), 'socks5://[::1]:1080');
  assert.equal(formatProxyRule(parseProxy('http://127.0.0.1:8080')), 'http://127.0.0.1:8080');
});

await test('diagnostics redact proxy credentials', () => {
  const redacted = redactProxyUrl('socks5://user:s3cret@127.0.0.1:1080');
  assert.equal(redacted.includes('s3cret'), false);
  assert.equal(redacted.includes('user'), false);
  assert.match(redacted, /127\.0\.0\.1/);
  assert.equal(redactProxyUrl('s3cret-but-not-a-url'), '(invalid)');
});

/* Protocol round trips */

const { server, port, requests } = await startFakeServer();
const baseConfig = {
  email: 'tester@example.com',
  secret: 'app-code',
  host: '127.0.0.1',
  port: port,
  secure: false,
};

await test('first check: baseline is UIDNEXT-1 and no alert is produced', async () => {
  const result = await checkMailbox(Object.assign({ lastUid: 0 }, baseConfig));
  assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
  assert.equal(result.initial, true);
  assert.equal(result.newUid, 12);
  assert.equal(result.newCount, 0);
  assert.equal(result.unread, 2);
});

await test('incremental check: only new UIDs, subjects and senders decoded', async () => {
  const result = await checkMailbox(Object.assign({ lastUid: 9 }, baseConfig));
  assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
  assert.equal(result.initial, false);
  assert.equal(result.newCount, 3);
  assert.equal(result.newUid, 12);

  const subjects = result.messages.map((message) => message.subject);
  assert.deepEqual(subjects, ['【测试】你好，世界', '测试', 'hello 你好 world']);
  assert.match(result.messages[0].from, /zhangsan@example\.com/);
});

await test('more than three new messages keep the real count and summarise three', async () => {
  await withServer({ uids: [1, 2, 3, 4, 5, 6], uidNext: 7 }, async () => {
    const result = await checkMailbox(Object.assign({ lastUid: 1 }, baseConfig));
    assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
    assert.equal(result.newCount, 5);
    assert.equal(result.messages.length, 3);
    assert.equal(result.newUid, 6);
    assert.deepEqual(
      result.messages.map((message) => message.uid),
      [4, 5, 6]
    );
  });
});

await test('UID after the header literal is still decoded', async () => {
  await withServer({ uidAtEnd: true }, async () => {
    const result = await checkMailbox(Object.assign({ lastUid: 9 }, baseConfig));
    assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
    assert.equal(result.newCount, 3);
    assert.equal(result.messages[0].subject, '【测试】你好，世界');
  });
});

await test('missing UIDNEXT still records the highest UID', async () => {
  await withServer({ sendUidNext: false }, async () => {
    const result = await checkMailbox(Object.assign({ lastUid: 0 }, baseConfig));
    assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
    assert.equal(result.initial, true);
    assert.equal(result.newUid, 12);
    assert.equal(result.uidValidity, 42);
  });
});

await test('UIDVALIDITY change resets the baseline without alerting', async () => {
  await withServer({ uidValidity: 99, uids: [1, 2, 3, 4], uidNext: 5 }, async () => {
    const result = await checkMailbox(Object.assign({ lastUid: 12, uidValidity: 42 }, baseConfig));
    assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
    assert.equal(result.initial, true);
    assert.equal(result.newCount, 0);
    assert.equal(result.messages.length, 0);
    assert.equal(result.newUid, 4);
    assert.equal(result.uidValidity, 99);
  });
});

await test('a stalled command fails with err.timeout instead of hanging', async () => {
  await withServer({ hangCommand: 'SELECT' }, async () => {
    const result = await Promise.race([
      checkMailbox(Object.assign({ lastUid: 5, timeout: 400 }, baseConfig)),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: { code: 'hung' } }), 2000)),
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'err.timeout');
  });
});

await test('an oversized literal is rejected without buffering it', async () => {
  await withServer({ hugeLiteral: true }, async () => {
    const started = Date.now();
    const result = await checkMailbox(Object.assign({ lastUid: 9, timeout: 2000 }, baseConfig));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'err.server');
    assert.ok(Date.now() - started < 1500, 'oversized literal took too long');
  });
});

await test('newline and NUL credentials are rejected before they are sent', async () => {
  requests.length = 0;
  const result = await checkMailbox(Object.assign({}, baseConfig, { secret: 'bad\r\nLOGIN injected' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'err.invalid');
  assert.equal(requests.some((line) => line.includes('injected')), false);

  requests.length = 0;
  const nulled = await checkMailbox(Object.assign({}, baseConfig, { secret: 'bad\0code' }));
  assert.equal(nulled.ok, false);
  assert.equal(nulled.error.code, 'err.invalid');
  assert.equal(requests.some((line) => line.includes('bad')), false);
});

await test('a host with a header injection is rejected before connect', async () => {
  const result = await checkMailbox(
    Object.assign({}, baseConfig, { host: 'imap.example.com\r\nX-Injected: 1', port: 1 })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'err.invalid');
});

await test('no new mail: newCount is 0 and the UID is unchanged', async () => {
  const result = await checkMailbox(Object.assign({ lastUid: 12 }, baseConfig));
  assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
  assert.equal(result.newCount, 0);
  assert.equal(result.newUid, 12);
});

await test('protocol sequence: LOGIN -> ID -> SELECT -> SEARCH -> FETCH -> LOGOUT', async () => {
  requests.length = 0;
  const result = await checkMailbox(Object.assign({ lastUid: 11 }, baseConfig));
  assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
  const joined = requests.join('\n');
  ['LOGIN', 'ID', 'SELECT', 'UID SEARCH', 'UID FETCH', 'LOGOUT'].forEach((command) => {
    assert.ok(joined.indexOf(command) !== -1, 'missing ' + command + '\nrequests:\n' + joined);
  });
});

const socks = await startSocksProxy();

await test('proxied check through a local SOCKS5 proxy', async () => {
  const result = await checkMailbox(
    Object.assign({ lastUid: 9, proxy: parseProxy('socks5://127.0.0.1:' + socks.port) }, baseConfig)
  );
  assert.equal(result.ok, true, 'error: ' + JSON.stringify(result.error));
  assert.equal(result.newCount, 3);
  assert.equal(result.newUid, 12);
});

socks.server.close();
await test('wrong credentials surface err.auth', async () => {
  const result = await checkMailbox(Object.assign({ lastUid: 0 }, baseConfig, { secret: 'wrong-code' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'err.auth');
});

await test('unreachable host surfaces err.network or err.timeout', async () => {
  const result = await checkMailbox({
    email: 'tester@example.com',
    secret: 'x',
    host: '127.0.0.1',
    port: 9,
    secure: false,
    lastUid: 0,
  });
  assert.equal(result.ok, false);
  assert.ok(['err.network', 'err.timeout'].includes(result.error.code), 'got: ' + result.error.code);
});

server.close();

/* ------------------------------------------------------------------ */
/* Summary                                                            */
/* ------------------------------------------------------------------ */

console.log('');
if (failures.length > 0) {
  console.log('FAILED · ' + failures.length + ' case(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('PASSED · ' + passed + ' cases');
