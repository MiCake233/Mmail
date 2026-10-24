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

const { parseHeaders, decodeWords } = imapModule;
const { checkMailbox } = mailcheckModule;

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
      socket.write('* 4 EXISTS\r\n');
      socket.write('* OK [UIDVALIDITY 42] UIDs valid\r\n');
      socket.write('* OK [UIDNEXT 13] Predicted next UID\r\n');
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
          const list = SERVER_UIDS.filter((uid) => uid >= lower);
          /* IMAP semantics: n:* always yields at least the highest UID. */
          socket.write('* SEARCH ' + (list.length ? list.join(' ') : String(SERVER_UIDS[SERVER_UIDS.length - 1])) + '\r\n');
        } else {
          socket.write('* SEARCH ' + SERVER_UIDS.join(' ') + '\r\n');
        }
      }
      socket.write(tag + ' OK SEARCH completed\r\n');
      break;
    }

    case 'FETCH': {
      const uidList = (/(\d+(?:,\d+)*)/.exec(rest) || [, ''])[1];
      const uids = uidList ? uidList.split(',').map(Number) : [];
      uids.forEach((uid, index) => {
        const header = HEADERS[uid] || 'Subject: (none)\r\n\r\n';
        const literal = Buffer.from(header, 'latin1');
        socket.write('* ' + (index + 1) + ' FETCH (UID ' + uid + ' BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {' + literal.length + '}\r\n');
        socket.write(literal);
        socket.write(')\r\n');
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
