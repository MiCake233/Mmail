#!/usr/bin/env node
/**
 * Mmail · static self-check
 * ---------------------------------------------------------------------------
 * Runs offline and without Electron. Verifies:
 *   1. every script parses;
 *   2. the provider catalogue is well formed (unique ids, https URLs, colours,
 *      IMAP presets, bilingual notes);
 *   3. zh and en locale tables share the same key set and the same placeholders;
 *   4. every key referenced by the UI exists, and no key is orphaned;
 *   5. index.html contains the required elements and references existing files;
 *   6. JSON files parse and package.json points at a real entry point;
 *   7. source comments are English (the locale data files are exempt).
 *
 * Usage: npm run check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const messages = [];

const ok = (message) => messages.push('[ok]   ' + message);
const fail = (message) => problems.push('[fail] ' + message);
const warn = (message) => messages.push('[warn] ' + message);

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function compile(relative) {
  try {
    new Function(read(relative));
    return true;
  } catch (error) {
    fail('syntax error · ' + relative + ' -> ' + error.message);
    return false;
  }
}

/** Browser classic script: run it in a sandbox and read what it assigns to window. */
function loadClassic(relative, globalName) {
  const sandbox = {};
  new Function('window', read(relative))(sandbox);
  return sandbox[globalName];
}

/* ------------------------------------------------------------------ */
/* 1. Syntax                                                          */
/* ------------------------------------------------------------------ */

const scripts = [
  'web/src/providers.js',
  'web/src/locales.js',
  'web/src/i18n.js',
  'web/src/app.js',
  'web/sw.js',
  'electron/main.js',
  'electron/preload.js',
  'electron/store.js',
  'electron/imap.js',
  'electron/mailcheck.js',
  'electron/strings.js',
];

scripts.forEach((file) => {
  if (!exists(file)) {
    fail('missing file · ' + file);
    return;
  }
  compile(file);
});
if (problems.length === 0) ok('syntax: ' + scripts.length + ' scripts parse');

/* ------------------------------------------------------------------ */
/* 2. Provider catalogue                                              */
/* ------------------------------------------------------------------ */

const data = loadClassic('web/src/providers.js', 'MmailData');
const PROVIDERS = (data && data.PROVIDERS) || [];
const CATEGORIES = (data && data.CATEGORIES) || [];

if (!PROVIDERS.length) fail('provider catalogue is empty');

const seenIds = new Set();
const seenNames = new Set();
const seenUrls = new Set();
const HEX = /^#[0-9a-fA-F]{6}$/;
const REGIONS = new Set(['cn', 'intl']);
const IMAP_MODES = new Set(['password', 'app-password', 'oauth']);

PROVIDERS.forEach((provider, index) => {
  const label = 'providers[' + index + '](' + (provider && provider.id) + ')';

  if (!provider || typeof provider !== 'object') {
    fail(label + ' is not an object');
    return;
  }
  if (!/^[a-z0-9-]+$/.test(provider.id || '')) fail(label + ' id must be a lowercase slug');
  if (seenIds.has(provider.id)) fail(label + ' duplicate id');
  seenIds.add(provider.id);

  if (!provider.name) fail(label + ' missing name');
  if (seenNames.has(provider.nameEn)) fail(label + ' duplicate nameEn: ' + provider.nameEn);
  seenNames.add(provider.nameEn);

  if (!/^https:\/\//.test(provider.url || '')) fail(label + ' url must be https');
  try {
    new URL(provider.url);
  } catch (error) {
    fail(label + ' url does not parse');
  }
  if (seenUrls.has(provider.url)) fail(label + ' duplicate url');
  seenUrls.add(provider.url);

  if (!provider.domain || /^https?:/.test(provider.domain)) fail(label + ' domain must be a bare host');
  if (!REGIONS.has(provider.region)) fail(label + ' region must be cn or intl');
  if (!HEX.test(provider.color || '')) fail(label + ' color must be #rrggbb');
  if (provider.ink && !HEX.test(provider.ink)) fail(label + ' ink must be #rrggbb');

  const markLength = Array.from(provider.mark || '').length;
  if (markLength < 1 || markLength > 4) fail(label + ' mark must be 1-4 characters');

  if (!provider.note || !provider.note.zh || !provider.note.en) fail(label + ' note needs zh and en');
  if (!Array.isArray(provider.keywords)) fail(label + ' keywords must be an array');

  if (provider.imap) {
    const imap = provider.imap;
    if (!imap.host) fail(label + ' imap.host is empty');
    if (!Number.isInteger(imap.port) || imap.port < 1 || imap.port > 65535) fail(label + ' imap.port invalid');
    if (!IMAP_MODES.has(imap.mode)) fail(label + ' imap.mode invalid');
    if (imap.help && !/^https:\/\//.test(imap.help)) fail(label + ' imap.help must be https');
  }
});

if (PROVIDERS.length) {
  const cn = PROVIDERS.filter((provider) => provider.region === 'cn').length;
  const intl = PROVIDERS.filter((provider) => provider.region === 'intl').length;
  const business = PROVIDERS.filter((provider) => provider.biz).length;
  const alertable = PROVIDERS.filter((provider) => provider.imap && provider.imap.mode !== 'oauth').length;
  ok(
    'providers: ' + PROVIDERS.length + ' (China ' + cn + ' / international ' + intl +
      ', business ' + business + ', alert-capable ' + alertable + ')'
  );
}

/* ------------------------------------------------------------------ */
/* 3. Locale data                                                     */
/* ------------------------------------------------------------------ */

const locales = loadClassic('web/src/locales.js', 'MmailLocales') || {};
const zhDict = locales.zh || {};
const enDict = locales.en || {};

const zhKeys = Object.keys(zhDict);
const enKeys = Object.keys(enDict);

zhKeys.filter((key) => !(key in enDict)).forEach((key) => fail('en is missing key · ' + key));
enKeys.filter((key) => !(key in zhDict)).forEach((key) => fail('zh is missing key · ' + key));

const placeholders = (text) => new Set(Array.from(String(text).matchAll(/\{(\w+)\}/g), (match) => match[1]));
zhKeys.forEach((key) => {
  if (!(key in enDict)) return;
  const zhVars = placeholders(zhDict[key]);
  const enVars = placeholders(enDict[key]);
  const same = zhVars.size === enVars.size && Array.from(zhVars).every((name) => enVars.has(name));
  if (!same) {
    fail(
      'placeholder mismatch · ' + key + ' -> zh{' + Array.from(zhVars).join(',') + '} en{' + Array.from(enVars).join(',') + '}'
    );
  }
});

if (problems.length === 0) ok('locales: ' + zhKeys.length + ' keys, both languages aligned');

/* Referenced keys */

const usedKeys = new Set();

try {
  const appCode = read('web/src/app.js');
  for (const match of appCode.matchAll(/\bt\(\s*'([^'\\]+)'/g)) usedKeys.add(match[1]);
  /* Keys used through ternaries or lookup tables. */
  for (const match of appCode.matchAll(/'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) {
    if (match[1] in zhDict) usedKeys.add(match[1]);
  }
} catch (error) {
  /* reported by the syntax check */
}

try {
  const html = read('web/index.html');
  for (const match of html.matchAll(/data-i18n(?:-ph|-aria|-title)?="([^"]+)"/g)) usedKeys.add(match[1]);
} catch (error) {
  /* ignore */
}

CATEGORIES.forEach((category) => usedKeys.add(category.key));

const missingKeys = Array.from(usedKeys).filter((key) => !(key in zhDict));
missingKeys.forEach((key) => fail('referenced key does not exist · ' + key));
if (missingKeys.length === 0) ok('references: ' + usedKeys.size + ' keys all exist');

/* Error codes the main process can return; translated at runtime via t(code). */
const MAIN_PROCESS_KEYS = new Set([
  'err.auth',
  'err.network',
  'err.tls',
  'err.timeout',
  'err.server',
  'err.imap',
  'err.unknown',
  'err.invalid',
  'err.limit',
  'err.duplicate',
]);

const unusedKeys = zhKeys.filter((key) => !usedKeys.has(key) && !MAIN_PROCESS_KEYS.has(key));
if (unusedKeys.length > 0) warn('orphaned keys (safe to delete) · ' + unusedKeys.join(', '));

/* ------------------------------------------------------------------ */
/* 4. Page structure                                                  */
/* ------------------------------------------------------------------ */

const REQUIRED_IDS = [
  'q',
  'clear',
  'filters',
  'content',
  'recents',
  'recents-list',
  'hint',
  'toast',
  'hero-subtitle',
  'lang-toggle',
  'theme-toggle',
  'settings-toggle',
  'settings',
  'settings-close',
  'settings-tabs',
  'settings-body',
  'mailbar',
  'mailbar-text',
  'mail-check',
  'mail-setup',
];

let html = '';
try {
  html = read('web/index.html');
} catch (error) {
  fail('missing web/index.html');
}

if (html) {
  const missingIds = REQUIRED_IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
  missingIds.forEach((id) => fail('index.html is missing #' + id));
  if (missingIds.length === 0) ok('markup: ' + REQUIRED_IDS.length + ' required elements present');

  const referenced = new Set();
  for (const match of html.matchAll(/(?:href|src)="\.\/([^"?#]+)"/g)) referenced.add('web/' + match[1]);
  referenced.forEach((file) => {
    if (!exists(file)) fail('index.html references a missing file · ' + file);
  });
  if (referenced.size > 0) ok('assets: ' + referenced.size + ' references resolve');

  const manifest = JSON.parse(read('web/manifest.webmanifest'));
  (manifest.icons || []).forEach((icon) => {
    const file = 'web/' + String(icon.src || '').replace(/^\.\//, '');
    if (!exists(file)) fail('manifest references a missing icon · ' + file);
  });

  const shellFiles = Array.from(read('web/sw.js').matchAll(/'(\.\/[^']+)'/g), (match) => match[1])
    .filter((item) => /\.[a-z]+$/.test(item) || item === './')
    .map((item) => 'web/' + item.replace(/^\.\//, ''));
  shellFiles.forEach((file) => {
    if (file === 'web/') return;
    if (!exists(file)) fail('service worker caches a missing file · ' + file);
  });

  const order = ['src/providers.js', 'src/locales.js', 'src/i18n.js', 'src/app.js'];
  let cursor = -1;
  order.forEach((name) => {
    const position = html.indexOf(name);
    if (position === -1) fail('index.html does not load ' + name);
    else if (position < cursor) fail('index.html loads scripts out of order at ' + name);
    else cursor = position;
  });
  if (!/defer/.test(html)) warn('index.html scripts should use defer');
}

/* ------------------------------------------------------------------ */
/* 5. JSON                                                            */
/* ------------------------------------------------------------------ */

['package.json', 'web/manifest.webmanifest'].forEach((file) => {
  if (!exists(file)) {
    fail('missing ' + file);
    return;
  }
  try {
    JSON.parse(read(file));
  } catch (error) {
    fail('invalid JSON · ' + file + ' -> ' + error.message);
  }
});

const pkg = JSON.parse(read('package.json'));
if (!pkg.main || !exists(pkg.main)) fail('package.json main points at a missing file · ' + pkg.main);
if (pkg.main && exists(pkg.main)) ok('entry point: ' + pkg.main + ' (Electron)');

/* ------------------------------------------------------------------ */
/* 6. Comment language                                                */
/* ------------------------------------------------------------------ */

const COMMENT_FILES = [
  'web/src/providers.js',
  'web/src/app.js',
  'web/src/i18n.js',
  'web/src/styles.css',
  'web/sw.js',
  'electron/main.js',
  'electron/imap.js',
  'electron/mailcheck.js',
  'electron/store.js',
  'electron/preload.js',
  'scripts/check.mjs',
  'scripts/serve.mjs',
  'scripts/test-imap.mjs',
  'scripts/test-store.js',
];

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const nonEnglishComments = [];

COMMENT_FILES.forEach((file) => {
  if (!exists(file)) return;
  read(file)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      const isComment =
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('<!--') ||
        trimmed.startsWith('#');
      if (isComment && CJK.test(line)) nonEnglishComments.push(file + ':' + (index + 1));
    });
});

nonEnglishComments.slice(0, 10).forEach((location) => fail('non-English comment · ' + location));
if (nonEnglishComments.length === 0) ok('comments: source comments are English');

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

console.log('Mmail self-check · ' + new Date().toISOString());
console.log('');
messages.forEach((message) => console.log(message));
problems.forEach((message) => console.log(message));
console.log('');

if (problems.length > 0) {
  console.log('FAILED · ' + problems.length + ' problem(s)');
  process.exit(1);
}

console.log('PASSED');
