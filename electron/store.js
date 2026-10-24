'use strict';

/**
 * Mmail · local settings and encrypted credentials
 * ---------------------------------------------------------------------------
 * Everything lives in mmail.json under userData:
 *   - app: launch at login, start minimized
 *   - mail: alert toggle and interval
 *   - ui: UI language (used for notifications)
 *   - accounts: alert accounts; the secret is encrypted by the OS (DPAPI on Windows)
 *
 * Writes use a temp file plus rename so a crash cannot leave a half-written file.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const MAX_ACCOUNTS = 8;

function defaults() {
  return {
    version: 1,
    app: {
      autoStart: false,
      startMinimized: false,
      /* system: follow the OS proxy; direct: never; custom: use proxy.url */
      proxy: { mode: 'system', url: '' },
    },
    mail: {
      enabled: true,
      intervalMinutes: 10,
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    },
    ui: { lang: 'zh', updateCheck: false, latestVersion: '' },
    accounts: [],
  };
}

/** Encrypt an auth code with the OS keystore; falls back to Base64 with enc:'none' when unavailable.
 *  Electron 45 prefers the async safeStorage API; use it when present and fall back to the sync one. */
const HAS_ASYNC_SAFE_STORAGE = typeof safeStorage.encryptStringAsync === 'function';

async function isEncryptionAvailable() {
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      return await safeStorage.isAsyncEncryptionAvailable();
    }
    return safeStorage.isEncryptionAvailable();
  } catch (err) {
    return false;
  }
}

async function encryptSecret(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return null;

  if (await isEncryptionAvailable()) {
    const buffer = HAS_ASYNC_SAFE_STORAGE
      ? await safeStorage.encryptStringAsync(plain)
      : safeStorage.encryptString(plain);
    return { v: 1, enc: 'os', data: Buffer.from(buffer).toString('base64') };
  }
  return { v: 1, enc: 'none', data: Buffer.from(plain, 'utf8').toString('base64') };
}

async function decryptSecret(record) {
  if (!record || !record.data) return '';
  try {
    const buffer = Buffer.from(record.data, 'base64');
    if (record.enc === 'none') return buffer.toString('utf8');

    const value = HAS_ASYNC_SAFE_STORAGE
      ? await safeStorage.decryptStringAsync(buffer)
      : safeStorage.decryptString(buffer);

    /* Electron 45 returns { result, shouldReEncrypt }; older versions return string / Buffer */
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && typeof value.result === 'string') {
      return value.result;
    }
    return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  } catch (err) {
    return '';
  }
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'mmail.json');
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = defaults();
      return {
        version: 1,
        app: Object.assign(base.app, parsed.app || {}),
        mail: Object.assign(base.mail, parsed.mail || {}),
        ui: Object.assign(base.ui, parsed.ui || {}),
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      };
    } catch (err) {
      return defaults();
    }
  }

  save() {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      /* already exists */
    }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /* ---------- Settings ---------- */

  setApp(patch) {
    Object.assign(this.data.app, patch || {});
    this.save();
    return this.data.app;
  }

  setMail(patch) {
    Object.assign(this.data.mail, patch || {});
    this.save();
    return this.data.mail;
  }

  setUi(patch) {
    Object.assign(this.data.ui, patch || {});
    this.save();
    return this.data.ui;
  }

  /* ---------- Accounts ---------- */

  /** Account fields exposed to the renderer; never includes the secret. */
  toPublic(account) {
    return {
      id: account.id,
      providerId: account.providerId,
      email: account.email,
      host: account.host,
      port: account.port,
      secure: account.secure !== false,
      notify: account.notify !== false,
      /* false when the OS keystore is unavailable and the secret fell back to Base64 */
      encrypted: Boolean(account.secret && account.secret.enc === 'os'),
      lastCheck: account.lastCheck || null,
    };
  }

  listAccounts() {
    return this.data.accounts.map((account) => this.toPublic(account));
  }

  getAccount(id) {
    return this.data.accounts.find((account) => account.id === id) || null;
  }

  async addAccount(input) {
    if (this.data.accounts.length >= MAX_ACCOUNTS) {
      const err = new Error('too-many-accounts');
      err.code = 'ERR_ACCOUNT_LIMIT';
      throw err;
    }
    const account = {
      id: crypto.randomUUID(),
      providerId: String(input.providerId || ''),
      email: String(input.email || '').trim(),
      host: String(input.host || '').trim(),
      port: Number(input.port) || 993,
      secure: input.secure !== false,
      secret: await encryptSecret(input.secret),
      lastUid: 0,
      lastCheck: null,
      notify: true,
      createdAt: Date.now(),
    };
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  updateAccount(id, patch) {
    const account = this.getAccount(id);
    if (!account) return null;
    Object.assign(account, patch || {});
    this.save();
    return account;
  }

  removeAccount(id) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
    if (this.data.accounts.length !== before) this.save();
    return this.data.accounts.length !== before;
  }

  /** Connection info for IMAP, including the decrypted secret (main process memory only). */
  async connectionOf(account) {
    return {
      id: account.id,
      email: account.email,
      host: account.host,
      port: account.port,
      secure: account.secure !== false,
      secret: await decryptSecret(account.secret),
      lastUid: Number(account.lastUid) || 0,
    };
  }

  get proxy() {
    const proxy = this.data.app.proxy || {};
    const mode = ['system', 'direct', 'custom'].includes(proxy.mode) ? proxy.mode : 'system';
    return { mode: mode, url: String(proxy.url || '') };
  }

  get quietHours() {
    const quiet = this.data.mail.quietHours || {};
    return {
      enabled: Boolean(quiet.enabled),
      start: /^d{2}:d{2}$/.test(String(quiet.start)) ? String(quiet.start) : '22:00',
      end: /^d{2}:d{2}$/.test(String(quiet.end)) ? String(quiet.end) : '08:00',
    };
  }

  /** Snapshot consumed by the renderer. */
  snapshot(runtime) {
    const info = runtime || {};
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      autoStart: Boolean(this.data.app.autoStart),
      startMinimized: Boolean(this.data.app.startMinimized),
      lang: this.data.ui.lang === 'en' ? 'en' : 'zh',
      proxy: this.proxy,
      updateCheck: Boolean(this.data.ui.updateCheck),
      latestVersion: String(this.data.ui.latestVersion || ''),
      mail: {
        enabled: Boolean(this.data.mail.enabled),
        intervalMinutes: Number(this.data.mail.intervalMinutes) || 10,
        quietHours: this.quietHours,
        checking: Boolean(info.checking),
        lastCheck: info.lastCheck || null,
        accounts: this.listAccounts(),
      },
    };
  }
}

module.exports = { Store, encryptSecret, decryptSecret, MAX_ACCOUNTS };
