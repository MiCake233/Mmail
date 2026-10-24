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
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  Notification,
  shell,
  ipcMain,
  nativeImage,
  session,
  clipboard,
  net,
} = require('electron');

const { Store, MAX_ACCOUNTS } = require('./store');
const { checkMailbox } = require('./mailcheck');
const { probe, parseProxy } = require('./imap');
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

/* ------------------------------------------------------------------------- */
/* ---------- Proxy                                                          */
/* ------------------------------------------------------------------------- */

/** Best-effort lookup of the OS proxy, used when the mode is "system". */
function systemProxyUrl() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (env) return env;

  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 3000 }
      );
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(output)) return null;
      const match = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(output);
      if (!match) return null;
      const value = match[1];
      const socks = /socks=([^;]+)/.exec(value);
      if (socks) return 'socks5://' + socks[1];
      const http = /(?:https?)=([^;]+)/.exec(value);
      if (http) return 'http://' + http[1];
      return 'http://' + value;
    }

    if (process.platform === 'darwin') {
      const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      if (/SOCKSEnable\s*:\s*1/.test(output)) {
        const host = /SOCKSProxy\s*:\s*([\w.\-]+)/.exec(output);
        const port = /SOCKSPort\s*:\s*(\d+)/.exec(output);
        if (host && port) return 'socks5://' + host[1] + ':' + port[1];
      }
      if (/HTTPSEnable\s*:\s*1/.test(output)) {
        const host = /HTTPSProxy\s*:\s*([\w.\-]+)/.exec(output);
        const port = /HTTPSPort\s*:\s*(\d+)/.exec(output);
        if (host && port) return 'http://' + host[1] + ':' + port[1];
      }
    }
  } catch (err) {
    /* detection is best-effort */
  }
  return null;
}

/** Resolve the configured proxy into a URL plus the parsed form used by IMAP. */
function resolvedProxy() {
  const settings = store.proxy;
  if (settings.mode === 'direct') return { url: null, parsed: null };
  if (settings.mode === 'custom') {
    const parsed = parseProxy(settings.url);
    return { url: parsed ? settings.url : null, parsed: parsed };
  }
  const url = systemProxyUrl();
  return { url: url, parsed: url ? parseProxy(url) : null };
}

function applyElectronProxy() {
  const resolved = resolvedProxy();
  const config = resolved.parsed
    ? {
        proxyRules:
          (resolved.parsed.type === 'socks5' ? 'socks5://' : 'http://') +
          resolved.parsed.host +
          ':' +
          resolved.parsed.port,
      }
    : { mode: 'direct' };
  try {
    session.defaultSession.setProxy(config);
    session.fromPartition(BROWSER_PARTITION).setProxy(config);
  } catch (err) {
    /* session may not exist yet; applied again on next start */
  }
}

/* ------------------------------------------------------------------------- */
/* ---------- Badge and quiet hours                                          */
/* ------------------------------------------------------------------------- */

function updateBadge(count) {
  const unread = Number(count) || 0;

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(unread > 0 ? String(unread) : '');
  }

  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(unread > 0 ? 'Mmail · ' + unread + ' unread' : 'Mmail');
  }

  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  if (unread <= 0) {
    win.setOverlayIcon(null, '');
    return;
  }
  const name = (unread > 9 ? '9plus' : String(unread)) + '.png';
  const image = nativeImage.createFromPath(path.join(ASSETS, 'badges', name));
  win.setOverlayIcon(image.isEmpty() ? null : image, unread + ' unread');
}

function totalUnread() {
  return store.data.accounts.reduce(
    (sum, account) => sum + ((account.lastCheck && account.lastCheck.unread) || 0),
    0
  );
}

function minutesOfDay(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!match) return fallback;
  return Math.min(1439, Math.max(0, Number(match[1]) * 60 + Number(match[2])));
}

function inQuietHours(now) {
  const quiet = store.quietHours;
  if (!quiet.enabled) return false;
  const date = now || new Date();
  const current = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(quiet.start, 22 * 60);
  const end = minutesOfDay(quiet.end, 8 * 60);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
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
    destroyBrowserView();
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

/** In development the launcher needs the application path; a packaged build does not. */
function loginItemArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function linuxAutostartFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'mmail.desktop');
}

function linuxExecLine() {
  const suffix = app.isPackaged ? ' --hidden' : ' "' + app.getAppPath() + '" --hidden';
  return '"' + process.execPath + '"' + suffix;
}

function setLinuxAutoStart(enabled) {
  const file = linuxAutostartFile();
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Mmail',
      'Comment=Mail sign-in launcher',
      'Exec=' + linuxExecLine(),
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
    'utf8'
  );
}

function setAutoStart(enabled) {
  store.setApp({ autoStart: Boolean(enabled) });
  try {
    /* Linux has no login-item API; the XDG autostart entry is the portable route. */
    if (process.platform === 'linux') {
      setLinuxAutoStart(Boolean(enabled));
      return;
    }
    const settings = { openAtLogin: Boolean(enabled) };
    if (process.platform === 'darwin') {
      settings.openAsHidden = true;
    } else {
      settings.path = process.execPath;
      settings.args = loginItemArgs();
    }
    app.setLoginItemSettings(settings);
  } catch (err) {
    /* System policy may forbid the change; keep the stored value */
  }
}

function syncAutoStartFromSystem() {
  try {
    if (process.platform === 'linux') {
      const enabled = fs.existsSync(linuxAutostartFile());
      if (enabled !== Boolean(store.data.app.autoStart)) store.setApp({ autoStart: enabled });
      return;
    }
    if (!app.isPackaged) return;
    const info =
      process.platform === 'darwin'
        ? app.getLoginItemSettings()
        : app.getLoginItemSettings({ args: loginItemArgs() });
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
    config.proxy = resolvedProxy().parsed;
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
  updateBadge(totalUnread());
  return snapshot();
}

function notifyNewMail(account, messages) {
  if (!Notification.isSupported()) return;
  if (account.notify === false) return;
  if (inQuietHours(new Date())) return;

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

/* ------------------------------------------------------------------------- */
/* ---------- Embedded browser                                               */
/* ------------------------------------------------------------------------- */

const BROWSER_PARTITION = 'persist:mmail-browser';

let browserView = null;

function destroyBrowserView() {
  if (!browserView) return;
  const view = browserView;
  browserView = null;
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  } catch (err) {
    /* window already gone */
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch (err) {
    /* already closed */
  }
}

function browserHistory(contents) {
  const history = contents.navigationHistory;
  if (history && typeof history.canGoBack === 'function') {
    return {
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      back: () => history.goBack(),
      forward: () => history.goForward(),
    };
  }
  return {
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
    back: () => contents.goBack(),
    forward: () => contents.goForward(),
  };
}

function browserState() {
  if (!browserView || browserView.webContents.isDestroyed()) return { open: false };
  const contents = browserView.webContents;
  const history = browserHistory(contents);
  return {
    open: true,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
  };
}

function pushBrowserState() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('browser:state', browserState());
  } catch (err) {
    /* window is closing */
  }
}

function ensureBrowserView() {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;

  /* A separate webContents with no preload and a persistent session partition:
     the page never sees Node, and sign-in cookies survive restarts. */
  browserView = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  const contents = browserView.webContents;

  /* OAuth and "open in new tab" flows rely on window.open; let Electron create
     real child windows that reuse the same session. */
  contents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    },
  }));

  contents.session.setPermissionRequestHandler((requesting, permission, callback) => callback(false));

  ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'did-fail-load'].forEach(
    (event) => contents.on(event, () => pushBrowserState())
  );
  contents.on('page-title-updated', () => pushBrowserState());

  win.contentView.addChildView(browserView);
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  return browserView;
}

function applyBrowserBounds(bounds) {
  if (!browserView) return;
  const rect = bounds || {};
  browserView.setBounds({
    x: Math.max(0, Math.round(Number(rect.x) || 0)),
    y: Math.max(0, Math.round(Number(rect.y) || 0)),
    width: Math.max(0, Math.round(Number(rect.width) || 0)),
    height: Math.max(0, Math.round(Number(rect.height) || 0)),
  });
}

function openInAppBrowser(url, bounds) {
  const view = ensureBrowserView();
  applyBrowserBounds(bounds);
  if (url) view.webContents.loadURL(url).catch(() => {});
  pushBrowserState();
  return browserState();
}

/* ------------------------------------------------------------------------- */
/* ---------- Update check and diagnostics                                   */
/* ------------------------------------------------------------------------- */

const RELEASES_URL = 'https://github.com/MiCake233/Mmail/releases';

function versionTokens(value) {
  const text = String(value || '').replace(/^v/, '');
  const parts = text.split('-');
  const core = parts[0];
  const pre = parts.slice(1).join('-');
  const nums = core.split('.').map((piece) => Number(piece) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums: nums, pre: pre };
}

function compareVersions(a, b) {
  const left = versionTokens(a);
  const right = versionTokens(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i] ? 1 : -1;
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  if (left.pre === right.pre) return 0;

  const leftPre = left.pre.split('.');
  const rightPre = right.pre.split('.');
  const length = Math.max(leftPre.length, rightPre.length);
  for (let i = 0; i < length; i += 1) {
    const l = leftPre[i] || '';
    const r = rightPre[i] || '';
    if (l === r) continue;
    const ln = Number(l);
    const rn = Number(r);
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln > rn ? 1 : -1;
    return l > r ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const response = await net.fetch('https://api.github.com/repos/MiCake233/Mmail/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mmail' },
    });
    if (!response.ok) {
      return { ok: false, error: { code: 'err.network', detail: 'HTTP ' + response.status } };
    }
    const releases = await response.json();
    const versions = (Array.isArray(releases) ? releases : [])
      .map((entry) => String(entry.tag_name || '').replace(/^v/, ''))
      .filter(Boolean)
      .sort(compareVersions);
    const latest = versions[versions.length - 1] || '';
    const hasUpdate = Boolean(latest) && compareVersions(latest, app.getVersion()) > 0;
    store.setUi({ latestVersion: hasUpdate ? latest : '' });
    broadcast();
    return {
      ok: true,
      current: app.getVersion(),
      latest: latest,
      hasUpdate: hasUpdate,
      url: RELEASES_URL,
    };
  } catch (err) {
    return { ok: false, error: { code: 'err.network', detail: String((err && err.message) || err).slice(0, 160) } };
  }
}

function diagnosticsText() {
  const proxy = store.proxy;
  const quiet = store.quietHours;
  const lines = [];
  lines.push('Mmail ' + app.getVersion());
  lines.push('platform: ' + process.platform + ' ' + process.arch);
  lines.push(
    'versions: electron ' + process.versions.electron + ', chromium ' + process.versions.chrome + ', node ' + process.versions.node
  );
  lines.push('proxy: ' + proxy.mode + (proxy.url ? ' (' + proxy.url + ')' : ''));
  lines.push(
    'alerts: enabled=' +
      Boolean(store.data.mail.enabled) +
      ', interval=' +
      store.data.mail.intervalMinutes +
      'min, quiet=' +
      (quiet.enabled ? quiet.start + '-' + quiet.end : 'off')
  );
  lines.push('accounts: ' + store.data.accounts.length);
  store.data.accounts.forEach((account) => {
    const last = account.lastCheck || {};
    lines.push(
      '  - ' +
        account.email +
        ' @ ' +
        account.host +
        ':' +
        account.port +
        ' notify=' +
        (account.notify !== false) +
        ' last=' +
        (last.ok ? 'ok unread=' + (last.unread || 0) : 'error ' + ((last.error && last.error.code) || 'unknown'))
    );
  });
  return lines.join('\n');
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
      case 'quietHours':
        store.setMail({
          quietHours: {
            enabled: Boolean(value && value.enabled),
            start: String((value && value.start) || '22:00'),
            end: String((value && value.end) || '08:00'),
          },
        });
        break;
      case 'proxy':
        store.setApp({
          proxy: {
            mode: ['system', 'direct', 'custom'].includes(value && value.mode) ? value.mode : 'system',
            url: String((value && value.url) || ''),
          },
        });
        applyElectronProxy();
        break;
      case 'updateCheck':
        store.setUi({ updateCheck: Boolean(value) });
        if (value) checkForUpdate();
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

  ipcMain.handle('update:check', () => checkForUpdate());

  ipcMain.handle('diag:copy', () => {
    try {
      clipboard.writeText(diagnosticsText());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { code: 'err.unknown', detail: String((err && err.message) || err) } };
    }
  });

  ipcMain.handle('mail:set-account-notify', (event, id, notify) => {
    store.updateAccount(String(id || ''), { notify: Boolean(notify) });
    broadcast();
    return snapshot();
  });

  ipcMain.handle('browser:clear', async () => {
    try {
      const target = session.fromPartition(BROWSER_PARTITION);
      await target.clearStorageData();
      await target.clearCache();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { code: 'err.unknown', detail: String((err && err.message) || err).slice(0, 160) } };
    }
  });

  ipcMain.handle('shell:open-external', (event, url) => {
    if (isExternalUrl(url)) shell.openExternal(url);
  });

  ipcMain.handle('browser:open', (event, url, bounds) => {
    if (!isExternalUrl(url)) return { open: false };
    return openInAppBrowser(url, bounds);
  });

  ipcMain.handle('browser:set-bounds', (event, bounds) => {
    applyBrowserBounds(bounds);
    return true;
  });

  ipcMain.handle('browser:close', () => {
    destroyBrowserView();
    return { open: false };
  });

  ipcMain.handle('browser:action', (event, action) => {
    if (!browserView || browserView.webContents.isDestroyed()) return { open: false };
    const contents = browserView.webContents;
    const history = browserHistory(contents);
    if (action === 'back' && history.canGoBack) history.back();
    else if (action === 'forward' && history.canGoForward) history.forward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
    else if (action === 'external') {
      const current = contents.getURL();
      if (isExternalUrl(current)) shell.openExternal(current);
    }
    return browserState();
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
  if (process.platform === 'win32') app.setAppUserModelId('com.mmail.app');

  store = new Store();
  providers = loadProviders();
  syncAutoStartFromSystem();

  registerIpc();

  const hidden = !SHOT_PATH && (process.argv.includes('--hidden') || store.data.app.startMinimized);
  createWindow(hidden);
  createTray();
  scheduleChecks();
  applyElectronProxy();
  updateBadge(totalUnread());

  if (store.data.ui.updateCheck) {
    setTimeout(() => {
      checkForUpdate();
    }, 8000);
  }

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
