'use strict';

/**
 * Mmail · Electron main process
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   - Own the main window (the UI lives in web/ and is shared with the web build).
 *   - Tray icon and menu.
 *   - Launch at login (Windows Run key / macOS Login Items).
 *   - Mail alerts: poll IMAP and raise a native notification for new mail.
 *   - Expose settings and accounts to the renderer over IPC (bridged by preload).
 *
 * Security: contextIsolation on, nodeIntegration off;
 * the renderer has no Node access and only sees whitelisted preload methods.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, nativeImage } = require('electron');

const { Store, MAX_ACCOUNTS } = require('./store');
const { checkMailbox } = require('./mailcheck');
const { probe } = require('./imap');
const { NOTIFY, TRAY, fill } = require('./strings');

const ASSETS = path.join(__dirname, '..', 'assets');
const WEB_INDEX = path.join(__dirname, '..', 'web', 'index.html');

const shotArg = process.argv.find((arg) => arg.indexOf('--screenshot=') === 0);
const SHOT_PATH = shotArg ? shotArg.slice('--screenshot='.length) : '';
const shotExecArg = process.argv.find((arg) => arg.indexOf('--screenshot-exec=') === 0);
const shotExec = shotExecArg ? shotExecArg.slice('--screenshot-exec='.length) : '';
const isDev = process.argv.includes('--dev');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let store = null;
let win = null;
let tray = null;
let checkTimer = null;
let checking = false;
let quitting = false;
let providers = [];
let lastCheck = null;

/* ------------------------------------------------------------------------- */
/* ---------- Helpers                                                            */
/* ------------------------------------------------------------------------- */

function loadProviders() {
  try {
    const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'providers.js'), 'utf8');
    const sandbox = {};
    // providers.js is a classic browser script that only assigns to window
    new Function('window', code)(sandbox);
    return (sandbox.MmailData && sandbox.MmailData.PROVIDERS) || [];
  } catch (err) {
    return [];
  }
}

function providerName(providerId, lang) {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return '';
  return lang === 'en' ? provider.nameEn : provider.name;
}

function isExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch (err) {
    return false;
  }
}

function clampInterval(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 10;
  return Math.min(180, Math.max(1, Math.round(minutes)));
}

function snapshot() {
  return store.snapshot({ checking: checking, lastCheck: lastCheck });
}

function broadcast() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('app:state', snapshot());
  } catch (err) {
    /* window is closing */
  }
  updateTrayMenu();
}

/* ------------------------------------------------------------------------- */
/* ---------- Window                                                             */
/* ------------------------------------------------------------------------- */

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 460,
    minHeight: 560,
    show: false,
    backgroundColor: '#f4f6fb',
    title: 'Mmail',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(WEB_INDEX);

  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    win = null;
  });

  /* External links go to the system browser; sign-in pages never open inside the app */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url.indexOf('file://') !== 0) {
      event.preventDefault();
      if (isExternalUrl(url)) shell.openExternal(url);
    }
  });

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  if (SHOT_PATH) {
    /* Development only: screenshots for docs and regression checks; never runs on normal start */
    win.webContents.once('did-finish-load', async () => {
      await delay(700);
      if (shotExec) {
        try {
          await win.webContents.executeJavaScript(shotExec, true);
        } catch (error) {
          console.error('screenshot exec failed: ' + error.message);
        }
        await delay(600);
      }
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(SHOT_PATH, image.toPNG());
        console.log('screenshot saved: ' + SHOT_PATH);
      } catch (error) {
        console.error('screenshot failed: ' + error.message);
      }
      quitting = true;
      app.quit();
    });
  }

  return win;
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow(false);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------------- */
/* ---------- Tray                                                               */
/* ------------------------------------------------------------------------- */

function createTray() {
  let icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  }
  if (icon.isEmpty()) return;

  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  } catch (err) {
    tray = null;
    return;
  }

  tray.setToolTip('Mmail');
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const lang = store && store.data.ui.lang === 'en' ? 'en' : 'zh';
  const labels = TRAY[lang];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.open, click: showWindow },
      { label: labels.check, click: () => runCheck({ manual: true }) },
      { type: 'separator' },
      {
        label: labels.auto,
        type: 'checkbox',
        checked: Boolean(store && store.data.app.autoStart),
        click: (item) => {
          setAutoStart(item.checked);
          broadcast();
        },
      },
      { type: 'separator' },
      { label: labels.quit, click: quitApp },
    ])
  );
}

/* ------------------------------------------------------------------------- */
/* ---------- Launch at login                                               */
/* ------------------------------------------------------------------------- */

/** In development electron.exe needs the app path; a packaged build does not. */
function loginItemArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function setAutoStart(enabled) {
  store.setApp({ autoStart: Boolean(enabled) });
  if (process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true,
      path: process.execPath,
      args: loginItemArgs(),
    });
  } catch (err) {
    /* System policy may forbid the change; keep the stored value */
  }
}

function syncAutoStartFromSystem() {
  if (process.platform === 'linux' || !app.isPackaged) return;
  try {
    const info = app.getLoginItemSettings({ args: loginItemArgs() });
    if (Boolean(info.openAtLogin) !== Boolean(store.data.app.autoStart)) {
      store.setApp({ autoStart: Boolean(info.openAtLogin) });
    }
  } catch (err) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------------- */
/* ---------- Mail alerts                                                    */
/* ------------------------------------------------------------------------- */

function scheduleChecks() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (!store.data.mail.enabled || store.data.accounts.length === 0) return;

  const minutes = clampInterval(store.data.mail.intervalMinutes);
  checkTimer = setInterval(() => {
    runCheck({ manual: false });
  }, minutes * 60 * 1000);
}

async function runCheck(options) {
  const manual = Boolean(options && options.manual);
  if (checking) return snapshot();
  if (!store.data.mail.enabled && !manual) return snapshot();
  if (store.data.accounts.length === 0) return snapshot();

  checking = true;
  broadcast();

  let totalNew = 0;
  let okCount = 0;
  let firstError = null;

  const accounts = store.data.accounts.slice();
  for (const account of accounts) {
    const config = await store.connectionOf(account);
    if (!config.secret) {
      firstError = firstError || { code: 'err.auth' };
      continue;
    }

    const result = await checkMailbox(config);
    const at = Date.now();

    if (result.ok) {
      okCount += 1;
      store.updateAccount(account.id, {
        lastUid: result.newUid,
        lastCheck: { at: at, ok: true, unread: result.unread, error: null },
      });
      if (result.newCount > 0) {
        totalNew += result.newCount;
        notifyNewMail(account, result.messages);
      }
    } else {
      firstError = firstError || result.error;
      store.updateAccount(account.id, {
        lastCheck: { at: at, ok: false, unread: 0, error: result.error },
      });
    }
  }

  checking = false;
  lastCheck = {
    at: Date.now(),
    newCount: totalNew,
    ok: okCount > 0 || accounts.length === 0,
    error: firstError,
  };
  broadcast();
  return snapshot();
}

function notifyNewMail(account, messages) {
  if (!Notification.isSupported()) return;

  const lang = store.data.ui.lang === 'en' ? 'en' : 'zh';
  const strings = NOTIFY[lang];
  const count = messages.length;
  const name = providerName(account.providerId, lang) || account.email;

  const title = fill(count === 1 ? strings.titleOne : strings.title, { name: name, count: count });
  const last = messages[messages.length - 1] || {};
  const subject = last.subject || strings.noSubject;
  const from = (last.from || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || strings.unknownSender;
  const extra = count > 1 ? ' · ' + fill(strings.more, { count: count - 1 }) : '';

  const notification = new Notification({
    title: title,
    body: from + ' — ' + subject + extra,
    icon: path.join(ASSETS, 'icon.png'),
  });

  notification.on('click', () => {
    const provider = providers.find((item) => item.id === account.providerId);
    if (provider && isExternalUrl(provider.url)) shell.openExternal(provider.url);
    showWindow();
  });

  notification.show();

  if (tray) {
    tray.setToolTip('Mmail · ' + title);
    setTimeout(() => {
      if (tray && !tray.isDestroyed()) tray.setToolTip('Mmail');
    }, 60000);
  }
}

/* ------------------------------------------------------------------------- */
/* IPC                                                                       */
/* ------------------------------------------------------------------------- */

function validatePayload(payload) {
  const input = payload || {};
  const value = {
    providerId: String(input.providerId || ''),
    email: String(input.email || '').trim(),
    secret: String(input.secret || ''),
    host: String(input.host || '').trim(),
    port: Number(input.port) || 993,
    secure: input.secure !== false,
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) return { error: { code: 'err.invalid' } };
  if (!value.secret || !value.host) return { error: { code: 'err.invalid' } };
  if (!(value.port > 0 && value.port < 65536)) return { error: { code: 'err.invalid' } };
  return { value: value };
}

function registerIpc() {
  ipcMain.handle('app:get-state', () => snapshot());

  ipcMain.handle('app:set-setting', (event, key, value) => {
    switch (key) {
      case 'autoStart':
        setAutoStart(Boolean(value));
        break;
      case 'startMinimized':
        store.setApp({ startMinimized: Boolean(value) });
        break;
      case 'mailEnabled':
        store.setMail({ enabled: Boolean(value) });
        scheduleChecks();
        if (value) runCheck({ manual: true });
        break;
      case 'intervalMinutes':
        store.setMail({ intervalMinutes: clampInterval(value) });
        scheduleChecks();
        break;
      default:
        break;
    }
    broadcast();
    return snapshot();
  });

  ipcMain.handle('mail:test-account', async (event, payload) => {
    const validated = validatePayload(payload);
    if (validated.error) return { ok: false, error: validated.error };
    const result = await probe(validated.value);
    return result.ok ? { ok: true, unread: result.unread } : { ok: false, error: result.error };
  });

  ipcMain.handle('mail:add-account', async (event, payload) => {
    if (store.data.accounts.length >= MAX_ACCOUNTS) return { ok: false, error: { code: 'err.limit' } };

    const validated = validatePayload(payload);
    if (validated.error) return { ok: false, error: validated.error };

    const duplicated = store.data.accounts.some(
      (account) => account.email.toLowerCase() === validated.value.email.toLowerCase()
    );
    if (duplicated) return { ok: false, error: { code: 'err.duplicate' } };

    /* Connect once before persisting so broken accounts never enter the list */
    const result = await checkMailbox(Object.assign({ lastUid: 0 }, validated.value));
    if (!result.ok) return { ok: false, error: result.error };

    const account = await store.addAccount(validated.value);
    store.updateAccount(account.id, {
      lastUid: result.newUid,
      lastCheck: { at: Date.now(), ok: true, unread: result.unread, error: null },
    });

    scheduleChecks();
    broadcast();
    return { ok: true, state: snapshot() };
  });

  ipcMain.handle('mail:remove-account', (event, id) => {
    store.removeAccount(String(id || ''));
    scheduleChecks();
    broadcast();
    return snapshot();
  });

  ipcMain.handle('mail:check-now', async () => {
    await runCheck({ manual: true });
    return snapshot();
  });

  ipcMain.handle('shell:open-external', (event, url) => {
    if (isExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.on('ui:set-lang', (event, lang) => {
    store.setUi({ lang: lang === 'en' ? 'en' : 'zh' });
    updateTrayMenu();
  });
}

/* ------------------------------------------------------------------------- */
/* ---------- Lifecycle                                                      */
/* ------------------------------------------------------------------------- */

function quitApp() {
  quitting = true;
  app.quit();
}

async function start() {
  app.setAppUserModelId('com.mmail.desktop');

  store = new Store();
  providers = loadProviders();
  syncAutoStartFromSystem();

  registerIpc();

  const hidden = !SHOT_PATH && (process.argv.includes('--hidden') || store.data.app.startMinimized);
  createWindow(hidden);
  createTray();
  scheduleChecks();

  /* Check shortly after start, once other startup programs settle */
  setTimeout(() => {
    if (store.data.mail.enabled && store.data.accounts.length > 0) {
      runCheck({ manual: false });
    }
  }, 15000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  /* Closing the window keeps the app in the tray so alerts keep working */
});

app.on('activate', () => {
  showWindow();
});
