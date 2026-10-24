/*!
 * Mmail · renderer logic
 * ---------------------------------------------------------------
 * Vanilla JS, no framework, no build step. Desktop capabilities come from window.mmail,
 * exposed by preload; a plain browser falls back to entries plus login history.
 *
 * Pure vanilla JS. Desktop capabilities come from `window.mmail`
 * (injected by electron/preload.js) and degrade gracefully in a browser.
 */
(function () {
  'use strict';

  const DATA = window.MmailData || { PROVIDERS: [], CATEGORIES: [] };
  const I18N = window.MmailI18n;
  const PROVIDERS = DATA.PROVIDERS;
  const CATEGORIES = DATA.CATEGORIES;
  const bridge = window.mmail || null;
  const isDesktop = Boolean(bridge && bridge.isDesktop);

  const STORE = {
    themeMode: 'mmail.themeMode',
    lang: 'mmail.lang',
    favs: 'mmail.favs',
    recent: 'mmail.recent',
    history: 'mmail.history',
  };

  const LIMITS = { recent: 6, toast: 1800, history: 30 };

  const els = {};
  const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));

  const EMPTY_DESKTOP = {
    appVersion: '',
    platform: '',
    autoStart: false,
    startMinimized: false,
    mail: { enabled: true, intervalMinutes: 10, checking: false, lastCheck: null, accounts: [] },
  };

  const state = {
    lang: 'zh',
    themeMode: 'system',
    query: '',
    filter: 'all',
    favs: new Set(),
    recent: [],
    history: {},
    desktop: EMPTY_DESKTOP,
    settingsTab: 'general',
    adding: false,
    busy: false,
    form: { providerId: '', email: '', secret: '', host: '', port: '', secure: true },
    testResult: null,
  };

  let t = I18N.translator('zh');
  let toastTimer = 0;
  let dateFormatters = {};
  let lastFocused = null;

  /* ------------------------------------------------------------------ */
  /* ---------- Utilities                                                  */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function readRaw(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function writeRaw(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* private mode or storage disabled */
    }
  }

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* ignore */
    }
  }

  function pName(provider) {
    return state.lang === 'en' ? provider.nameEn : provider.name;
  }

  function pNote(provider) {
    return state.lang === 'en' ? provider.note.en : provider.note.zh;
  }

  function timeAgo(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { n: hours });
    return t('time.daysAgo', { n: Math.round(hours / 24) });
  }

  function clock(timestamp) {
    const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
    if (!dateFormatters[locale]) {
      dateFormatters[locale] = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    }
    return dateFormatters[locale].format(new Date(timestamp));
  }

  function errorText(error) {
    if (!error) return '';
    const code = error.code || 'err.unknown';
    return t(code, error.detail ? { detail: error.detail } : undefined);
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('is-on');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('is-on'), LIMITS.toast);
  }

  function searchHaystack(provider) {
    const parts = [provider.name, provider.nameEn, provider.domain, provider.url, provider.mark];
    return parts.concat(provider.keywords || []).join(' ').toLowerCase();
  }

  const HAY = new Map(PROVIDERS.map((p) => [p.id, searchHaystack(p)]));

  /* ------------------------------------------------------------------ */
  /* ---------- Theme                                                        */
  /* ------------------------------------------------------------------ */

  function prefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolveDark(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return prefersDark();
  }

  function syncThemeColor(dark) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#070b12' : '#f4f6fb');
  }

  function applyThemeMode(mode, persist) {
    state.themeMode = mode === 'dark' || mode === 'light' ? mode : 'system';
    const dark = resolveDark(state.themeMode);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    syncThemeColor(dark);
    if (persist) writeRaw(STORE.themeMode, state.themeMode);
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Language                                                     */
  /* ------------------------------------------------------------------ */

  function applyLanguage(lang, persist) {
    state.lang = lang === 'en' ? 'en' : 'zh';
    t = I18N.translator(state.lang);
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
    if (persist) writeRaw(STORE.lang, state.lang);
    if (isDesktop && bridge.setLang) {
      try {
        bridge.setLang(state.lang);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function applyStaticI18n() {
    $$('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    $$('[data-i18n-ph]').forEach((node) => {
      node.placeholder = t(node.dataset.i18nPh);
    });
    $$('[data-i18n-aria]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    });
    $$('[data-i18n-title]').forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Favorites, recents, login history                                               */
  /* ------------------------------------------------------------------ */

  const knownId = (id) => providerById.has(id);

  function recordOpen(id) {
    const provider = providerById.get(id);
    if (!provider) return;

    state.recent = [id].concat(state.recent.filter((item) => item !== id)).slice(0, LIMITS.recent);
    writeJson(STORE.recent, state.recent);

    const entry = state.history[id] || { count: 0, lastAt: 0 };
    entry.count += 1;
    entry.lastAt = Date.now();
    state.history[id] = entry;
    writeJson(STORE.history, state.history);

    renderRecents();
    if (isSettingsOpen() && state.settingsTab === 'history') renderSettings();
    showToast(t('toast.opened', { name: pName(provider) }));
  }

  function toggleFavorite(id) {
    const provider = providerById.get(id);
    if (!provider) return;
    const wasFavorite = state.favs.has(id);
    if (wasFavorite) state.favs.delete(id);
    else state.favs.add(id);
    writeJson(STORE.favs, Array.from(state.favs));

    renderChips();
    renderContent();
    if (isSettingsOpen()) renderSettings();
    showToast(t(wasFavorite ? 'toast.unfaved' : 'toast.faved', { name: pName(provider) }));

    const button = els.content.querySelector('.star[data-fav="' + id + '"]');
    if (button) button.focus({ preventScroll: true });
  }

  function clearHistory() {
    state.history = {};
    writeJson(STORE.history, {});
    renderSettings();
    showToast(t('toast.historyCleared'));
  }

  /* ------------------------------------------------------------------ */
  /* ---------- List rendering                                            */
  /* ------------------------------------------------------------------ */

  const CATEGORY_TEST = {
    all: () => true,
    cn: (p) => p.region === 'cn',
    intl: (p) => p.region === 'intl',
    biz: (p) => Boolean(p.biz),
    fav: (p) => state.favs.has(p.id),
  };

  function visibleProviders() {
    const tokens = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const test = CATEGORY_TEST[state.filter] || CATEGORY_TEST.all;
    return PROVIDERS.filter((p) => {
      if (!test(p)) return false;
      if (tokens.length === 0) return true;
      const haystack = HAY.get(p.id);
      return tokens.every((token) => haystack.includes(token));
    });
  }

  function cardMarkup(provider) {
    const length = Array.from(provider.mark).length;
    const style = '--c:' + provider.color + (provider.ink ? ';--ink:' + provider.ink : '');
    return (
      '<span class="mark" data-len="' + length + '" style="' + style + '">' +
      '<span>' + esc(provider.mark) + '</span></span>'
    );
  }

  function cardMarkupTitle(provider) {
    const parts = [pNote(provider)];
    const entry = state.history[provider.id];
    if (entry && entry.lastAt) parts.push(t('card.lastUsed', { time: timeAgo(entry.lastAt) }));
    return parts.filter(Boolean).join('\n');
  }

  function cardFavoriteLabel(provider, favorite) {
    return t(favorite ? 'card.unfavorite' : 'card.favorite') + ' ' + pName(provider);
  }

  function cardTemplate(provider) {
    const favorite = state.favs.has(provider.id);
    return (
      '<li class="card" data-id="' + esc(provider.id) + '">' +
        '<a class="card-link" href="' + esc(provider.url) + '" target="_blank" rel="noopener noreferrer"' +
          ' data-open="' + esc(provider.id) + '" title="' + esc(cardMarkupTitle(provider)) + '">' +
          cardMarkup(provider) +
          '<span class="meta">' +
            '<span class="name">' + esc(pName(provider)) + '</span>' +
            '<span class="domain">' + esc(provider.domain) + '</span>' +
          '</span>' +
        '</a>' +
        '<button class="star" type="button" data-fav="' + esc(provider.id) + '" aria-pressed="' + favorite + '"' +
          ' aria-label="' + esc(cardFavoriteLabel(provider, favorite)) + '"' +
          ' title="' + esc(cardFavoriteLabel(provider, favorite)) + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.7l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.72l-5.1 2.68.97-5.68L3.75 9.7l5.7-.83z"/></svg>' +
        '</button>' +
      '</li>'
    );
  }

  function sectionTemplate(title, items) {
    return (
      '<section class="section" aria-label="' + esc(title) + '">' +
        '<div class="section-head">' +
          '<h2>' + esc(title) + '</h2>' +
          '<span class="count">' + items.length + '</span>' +
          '<span class="line" aria-hidden="true"></span>' +
        '</div>' +
        '<ul class="grid">' + items.map(cardTemplate).join('') + '</ul>' +
      '</section>'
    );
  }

  function emptyTemplate() {
    const favoritesEmpty = state.filter === 'fav' && !state.query.trim();
    const title = t(favoritesEmpty ? 'empty.favTitle' : 'empty.searchTitle');
    const text = t(favoritesEmpty ? 'empty.favText' : 'empty.searchText');
    return (
      '<div class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">' +
          '<rect x="3" y="5.5" width="18" height="13" rx="3.2"/><path d="m4.8 8 6 4.4a2 2 0 0 0 2.4 0l6-4.4"/>' +
        '</svg>' +
        '<p class="empty-title">' + esc(title) + '</p>' +
        '<p class="empty-text">' + esc(text) + '</p>' +
        '<button class="chip" type="button" data-action="reset">' + esc(t('empty.reset')) + '</button>' +
      '</div>'
    );
  }

  function renderHero() {
    const template = t('hero.subtitle', { count: '__COUNT__' });
    els.heroSubtitle.innerHTML = esc(template).replace('__COUNT__', '<strong>' + PROVIDERS.length + '</strong>');
  }

  function chipCount(id) {
    if (id === 'fav') return state.favs.size;
    const test = CATEGORY_TEST[id];
    if (!test) return 0;
    if (id === 'all') return PROVIDERS.length;
    return PROVIDERS.filter(test).length;
  }

  function renderChips() {
    els.filters.innerHTML = CATEGORIES.map((category) => {
      const pressed = category.id === state.filter;
      return (
        '<button class="chip" type="button" data-filter="' + esc(category.id) + '" aria-pressed="' + pressed + '">' +
          '<span>' + esc(t(category.key)) + '</span>' +
          '<span class="count">' + chipCount(category.id) + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function renderRecents() {
    const items = state.recent.map((id) => providerById.get(id)).filter(Boolean);
    els.recents.hidden = items.length === 0;
    els.recentsList.innerHTML = items
      .map(
        (provider) =>
          '<a class="rec-item" href="' + esc(provider.url) + '" target="_blank" rel="noopener noreferrer"' +
          ' data-open="' + esc(provider.id) + '" style="--c:' + esc(provider.color) + '">' +
          '<span class="rec-dot" aria-hidden="true"></span>' + esc(pName(provider)) + '</a>'
      )
      .join('');
  }

  function renderContent() {
    const items = visibleProviders();
    let html = '';

    if (items.length === 0) {
      html = emptyTemplate();
    } else if (state.filter === 'all' && !state.query.trim()) {
      const groups = [
        { title: t('section.cn'), items: items.filter((p) => p.region === 'cn') },
        { title: t('section.intl'), items: items.filter((p) => p.region === 'intl') },
      ];
      html = groups.filter((g) => g.items.length).map((g) => sectionTemplate(g.title, g.items)).join('');
    } else {
      const category = CATEGORIES.find((c) => c.id === state.filter);
      const title = state.query.trim() ? t('section.search') : t(category ? category.key : 'filter.all');
      html = sectionTemplate(title, items);
    }

    els.content.innerHTML = html;

    let hint = t('mail.title') + ': ' + items.length;
    if (state.query.trim()) hint = t('section.search') + ' "' + state.query.trim() + '" — ' + items.length;
    els.hint.textContent = hint;
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Mail status bar                                     */
  /* ------------------------------------------------------------------ */

  function renderMailBar() {
    if (!els.mailbar) return;
    const mail = state.desktop.mail;
    if (!isDesktop || !mail) {
      els.mailbar.hidden = true;
      return;
    }

    els.mailbar.hidden = false;
    const parts = [t('mail.title'), mail.enabled ? t('mail.on') : t('mail.off')];

    /* With no accounts, do not claim alerts are on; point at setup instead */
    if (mail.accounts.length === 0) {
      els.mailbarText.textContent = t('mail.title') + ' · ' + t('mail.noAccount');
      els.mailbar.dataset.tone = 'ok';
      els.mailSetup.hidden = false;
      els.mailCheck.hidden = true;
      return;
    }

    if (mail.accounts.length) parts.push(t('mail.accounts', { count: mail.accounts.length }));

    let status;
    let tone = 'ok';
    if (mail.checking) {
      status = t('mail.checking');
      tone = 'busy';
    } else if (mail.lastCheck && mail.lastCheck.error) {
      status = t('mail.failed') + ' · ' + errorText(mail.lastCheck.error);
      tone = 'error';
    } else if (mail.lastCheck && mail.lastCheck.at) {
      status = mail.lastCheck.newCount
        ? t('mail.newCount', { count: mail.lastCheck.newCount })
        : t('mail.upToDate');
    } else {
      status = t('mail.never');
    }
    if (mail.lastCheck && mail.lastCheck.at) parts.push(t('mail.lastCheck', { time: clock(mail.lastCheck.at) }));

    els.mailbarText.textContent = parts.join(' · ') + ' · ' + status;
    els.mailbar.dataset.tone = tone;
    els.mailSetup.hidden = mail.accounts.length > 0;
    els.mailCheck.hidden = mail.accounts.length === 0;
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Settings sheet                                            */
  /* ------------------------------------------------------------------ */

  const SETTINGS_TABS = [
    { id: 'general', key: 'settings.tab.general' },
    { id: 'mail', key: 'settings.tab.mail' },
    { id: 'history', key: 'settings.tab.history' },
    { id: 'about', key: 'settings.tab.about' },
  ];

  function isSettingsOpen() {
    return els.settings && !els.settings.hidden;
  }

  function themeOptions() {
    return [
      { id: 'system', label: t('settings.general.themeSystem') },
      { id: 'light', label: t('settings.general.themeLight') },
      { id: 'dark', label: t('settings.general.themeDark') },
    ];
  }

  function segmentedMarkup(attr, options, current) {
    return (
      '<div class="segmented" role="group">' +
      options
        .map(
          (option) =>
            '<button type="button" ' + attr + '="' + esc(option.id) + '" aria-pressed="' +
            (option.id === current) + '">' + esc(option.label) + '</button>'
        )
        .join('') +
      '</div>'
    );
  }

  function switchMarkup(setting, checked, disabled) {
    return (
      '<label class="switch' + (disabled ? ' is-disabled' : '') + '">' +
      '<input type="checkbox" data-setting="' + esc(setting) + '"' + (checked ? ' checked' : '') +
      (disabled ? ' disabled' : '') + ' />' +
      '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>' +
      '</label>'
    );
  }

  function renderGeneralTab() {
    const desktopOnly = !isDesktop;
    const notice = desktopOnly
      ? '<p class="notice">' + esc(t('settings.general.webMode')) + '</p>'
      : '';

    const languageSeg = segmentedMarkup(
      'data-lang',
      [
        { id: 'zh', label: '中文' },
        { id: 'en', label: 'English' },
      ],
      state.lang
    );

    return (
      notice +
      '<div class="field">' +
        '<div class="field-label">' + esc(t('settings.general.language')) + '</div>' +
        '<div class="field-desc">' + esc(t('settings.general.languageDesc')) + '</div>' +
        languageSeg +
      '</div>' +
      '<div class="field">' +
        '<div class="field-label">' + esc(t('settings.general.theme')) + '</div>' +
        '<div class="field-desc">' + esc(t('settings.general.themeDesc')) + '</div>' +
        segmentedMarkup('data-theme-mode', themeOptions(), state.themeMode) +
      '</div>' +
      '<div class="field">' +
        '<div class="field-row">' +
          '<div>' +
            '<div class="field-label">' + esc(t('settings.general.autostart')) +
              (desktopOnly ? ' <span class="tag">' + esc(t('settings.general.desktopOnly')) + '</span>' : '') +
            '</div>' +
            '<div class="field-desc">' + esc(t('settings.general.autostartDesc')) + '</div>' +
          '</div>' +
          switchMarkup('autoStart', Boolean(state.desktop.autoStart), desktopOnly) +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<div class="field-row">' +
          '<div>' +
            '<div class="field-label">' + esc(t('settings.general.startMinimized')) + '</div>' +
            '<div class="field-desc">' + esc(t('settings.general.startMinimizedDesc')) + '</div>' +
          '</div>' +
          switchMarkup('startMinimized', Boolean(state.desktop.startMinimized), desktopOnly) +
        '</div>' +
      '</div>'
    );
  }

  function providerOptions(selectedId) {
    const options = PROVIDERS.map((provider) => {
      const oauth = provider.imap && provider.imap.mode === 'oauth';
      return (
        '<option value="' + esc(provider.id) + '"' + (provider.id === selectedId ? ' selected' : '') +
        (oauth ? ' data-oauth="1"' : '') + '>' +
        esc(pName(provider)) + (oauth ? ' — OAuth' : '') +
        '</option>'
      );
    }).join('');
    return '<option value=""' + (selectedId ? '' : ' selected') + '>' + esc(t('settings.mail.customHost')) + '</option>' + options;
  }

  function accountRowMarkup(account) {
    const provider = providerById.get(account.providerId);
    const color = provider ? provider.color : '#5b7cfa';
    const mark = provider ? provider.mark : '@';
    const result = account.lastCheck
      ? account.lastCheck.ok
        ? t('settings.mail.result', { count: account.lastCheck.unread || 0 })
        : errorText(account.lastCheck.error)
      : t('mail.never');

    return (
      '<li class="account" data-id="' + esc(account.id) + '">' +
        '<span class="account-mark" style="--c:' + esc(color) + '">' + esc(mark) + '</span>' +
        '<span class="account-meta">' +
          '<span class="account-email">' + esc(account.email) + '</span>' +
          '<span class="account-sub">' + esc(result) + '</span>' +
        '</span>' +
        '<button class="ghost-btn ghost-btn--sm" type="button" data-act="remove-account" data-id="' + esc(account.id) + '">' +
          esc(t('settings.mail.remove')) +
        '</button>' +
      '</li>'
    );
  }

  function accountFormMarkup() {
    const form = state.form;
    const provider = providerById.get(form.providerId);
    const oauth = Boolean(provider && provider.imap && provider.imap.mode === 'oauth');
    const help =
      provider && provider.imap && provider.imap.help
        ? '<a class="link" href="' + esc(provider.imap.help) + '" target="_blank" rel="noopener noreferrer">' +
          esc(t('settings.mail.help')) + '</a>'
        : '';

    const result = state.testResult
      ? '<p class="form-result ' + (state.testResult.ok ? 'is-ok' : 'is-bad') + '">' +
        esc(
          state.testResult.ok
            ? t('settings.mail.result', { count: state.testResult.unread || 0 })
            : t('settings.mail.testFail', { reason: errorText(state.testResult.error) })
        ) +
        '</p>'
      : '';

    return (
      '<div class="account-form">' +
        '<div class="field-label">' + esc(t('settings.mail.addTitle')) + '</div>' +
        '<label class="input-row">' +
          '<span>' + esc(t('settings.mail.provider')) + '</span>' +
          '<select id="acc-provider" class="input">' + providerOptions(form.providerId) + '</select>' +
        '</label>' +
        '<label class="input-row">' +
          '<span>' + esc(t('settings.mail.email')) + '</span>' +
          '<input id="acc-email" class="input" type="email" autocomplete="off" spellcheck="false" value="' + esc(form.email) + '" placeholder="you@example.com" />' +
        '</label>' +
        '<label class="input-row">' +
          '<span>' + esc(t('settings.mail.secret')) + '</span>' +
          '<input id="acc-secret" class="input" type="password" autocomplete="new-password" value="' + esc(form.secret) + '" placeholder="' + esc(t('settings.mail.secretPlaceholder')) + '" />' +
        '</label>' +
        '<p class="field-desc">' + esc(t('settings.mail.secretHint')) + ' ' + help + '</p>' +
        '<div class="input-grid">' +
          '<label class="input-row">' +
            '<span>' + esc(t('settings.mail.host')) + '</span>' +
            '<input id="acc-host" class="input" type="text" autocomplete="off" spellcheck="false" value="' + esc(form.host) + '" placeholder="imap.example.com" />' +
          '</label>' +
          '<label class="input-row input-row--port">' +
            '<span>' + esc(t('settings.mail.port')) + '</span>' +
            '<input id="acc-port" class="input" type="number" min="1" max="65535" value="' + esc(form.port) + '" placeholder="993" />' +
          '</label>' +
        '</div>' +
        '<label class="check-row">' +
          '<input type="checkbox" id="acc-secure"' + (form.secure ? ' checked' : '') + ' data-setting="secure" />' +
          '<span>' + esc(t('settings.mail.ssl')) + '</span>' +
        '</label>' +
        (oauth ? '<p class="notice">' + esc(t('settings.mail.oauth')) + '</p>' : '') +
        (!provider || !provider.imap ? '<p class="field-desc">' + esc(t('settings.mail.noPreset')) + '</p>' : '') +
        '<p class="field-desc">' + esc(t('settings.mail.encNote')) + '</p>' +
        result +
        '<div class="form-actions">' +
          '<button class="ghost-btn" type="button" data-act="cancel-account">' + esc(t('action.cancel')) + '</button>' +
          '<button class="ghost-btn" type="button" data-act="test-account"' + (state.busy ? ' disabled' : '') + '>' +
            esc(state.busy ? t('settings.mail.testing') : t('settings.mail.test')) +
          '</button>' +
          '<button class="btn-primary" type="button" data-act="save-account"' + (state.busy ? ' disabled' : '') + '>' +
            esc(t('settings.mail.save')) +
          '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderMailTab() {
    if (!isDesktop) {
      return '<p class="notice">' + esc(t('settings.mail.webDisabled')) + '</p>';
    }

    const mail = state.desktop.mail;
    const accounts = mail.accounts || [];
    const intervals = [5, 10, 15, 30, 60];
    const intervalOptions = intervals
      .map(
        (minutes) =>
          '<option value="' + minutes + '"' + (minutes === mail.intervalMinutes ? ' selected' : '') + '>' +
          esc(t('settings.mail.intervalUnit', { n: minutes })) + '</option>'
      )
      .join('');

    const lastCheck =
      mail.lastCheck && mail.lastCheck.at
        ? t('settings.mail.lastResult', { time: clock(mail.lastCheck.at) })
        : t('mail.never');

    return (
      '<div class="field">' +
        '<div class="field-row">' +
          '<div>' +
            '<div class="field-label">' + esc(t('settings.mail.enable')) + '</div>' +
            '<div class="field-desc">' + esc(t('settings.mail.enableDesc')) + '</div>' +
          '</div>' +
          switchMarkup('mailEnabled', Boolean(mail.enabled), false) +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<div class="field-row">' +
          '<div class="field-label">' + esc(t('settings.mail.interval')) + '</div>' +
          '<select class="input input--sm" data-setting="interval">' + intervalOptions + '</select>' +
        '</div>' +
        '<div class="field-desc">' + esc(lastCheck) + '</div>' +
      '</div>' +
      '<div class="field">' +
        '<div class="field-label">' + esc(t('settings.mail.accounts')) + '</div>' +
        '<div class="field-desc">' + esc(t('settings.mail.accountsDesc')) + '</div>' +
        (accounts.length
          ? '<ul class="account-list">' + accounts.map(accountRowMarkup).join('') + '</ul>'
          : '<p class="field-desc">' + esc(t('settings.mail.empty')) + '</p>') +
        (state.adding
          ? accountFormMarkup()
          : '<button class="btn-primary" type="button" data-act="add-account">' + esc(t('settings.mail.add')) + '</button>') +
      '</div>'
    );
  }

  function renderHistoryTab() {
    const rows = Object.keys(state.history)
      .map((id) => ({ id: id, entry: state.history[id], provider: providerById.get(id) }))
      .filter((row) => row.provider && row.entry && row.entry.lastAt)
      .sort((a, b) => b.entry.lastAt - a.entry.lastAt)
      .slice(0, LIMITS.history);

    const body = rows.length
      ? '<ul class="history-list">' +
        rows
          .map(
            (row) =>
              '<li class="history-item">' +
                '<span class="rec-dot" style="--c:' + esc(row.provider.color) + '" aria-hidden="true"></span>' +
                '<span class="history-name">' + esc(pName(row.provider)) + '</span>' +
                '<span class="history-meta">' +
                  esc(t('settings.history.opened', { count: row.entry.count })) + ' · ' +
                  esc(t('settings.history.last', { time: timeAgo(row.entry.lastAt) })) +
                '</span>' +
              '</li>'
          )
          .join('') +
        '</ul>'
      : '<p class="field-desc">' + esc(t('settings.history.empty')) + '</p>';

    return (
      '<div class="field">' +
        '<div class="field-label">' + esc(t('settings.history.title')) + '</div>' +
        '<div class="field-desc">' + esc(t('settings.history.desc')) + '</div>' +
        body +
        (rows.length
          ? '<div class="form-actions"><button class="ghost-btn" type="button" data-act="clear-history">' +
            esc(t('settings.history.clear')) + '</button></div>'
          : '') +
      '</div>'
    );
  }

  function renderAboutTab() {
    const version = state.desktop.appVersion || '0.1.0-beta.1';
    return (
      '<div class="field">' +
        '<div class="field-label">Mmail</div>' +
        '<div class="field-desc">' + esc(t('settings.about.version', { version: version })) +
          ' · ' + esc(t('settings.about.beta')) + '</div>' +
        '<p class="about-text">' + esc(t('settings.about.desc')) + '</p>' +
        '<p class="field-desc">' + esc(t('settings.about.privacy')) + '</p>' +
        '<p class="notice">' + esc(t('settings.about.disclaimer')) + '</p>' +
        '<p class="field-desc">' + esc(t('settings.about.legal')) + '</p>' +
        '<p class="field-desc">' + esc(t('settings.about.license')) + '</p>' +
        '<p class="field-desc"><a class="link" href="https://github.com/MiCake233/Mmail" target="_blank" rel="noopener noreferrer">github.com/MiCake233/Mmail</a></p>' +
      '</div>'
    );
  }

  function renderSettings() {
    if (!isSettingsOpen()) return;
    els.tabs.innerHTML = SETTINGS_TABS.map(
      (tab) =>
        '<button class="sheet-tab" type="button" role="tab" data-tab="' + tab.id + '"' +
        ' aria-selected="' + (state.settingsTab === tab.id) + '">' + esc(t(tab.key)) + '</button>'
    ).join('');

    const renderers = {
      general: renderGeneralTab,
      mail: renderMailTab,
      history: renderHistoryTab,
      about: renderAboutTab,
    };
    els.body.innerHTML = (renderers[state.settingsTab] || renderGeneralTab)();
  }

  function openSettings(tab) {
    lastFocused = document.activeElement;
    state.settingsTab = tab || 'general';
    els.settings.hidden = false;
    document.documentElement.classList.add('is-locked');
    renderSettings();
    const closeButton = $('#settings-close');
    if (closeButton) closeButton.focus();
  }

  function closeSettings() {
    els.settings.hidden = true;
    document.documentElement.classList.remove('is-locked');
    state.adding = false;
    state.testResult = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function trapFocus(event) {
    if (event.key !== 'Tab' || !isSettingsOpen()) return;
    const focusables = $$(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      els.settings
    ).filter((node) => !node.disabled && node.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Desktop state                                          */
  /* ------------------------------------------------------------------ */

  function applyDesktopState(next) {
    if (!next) return;
    state.desktop = Object.assign({}, EMPTY_DESKTOP, next);
    state.desktop.mail = Object.assign({}, EMPTY_DESKTOP.mail, next.mail || {});
    renderMailBar();
    if (isSettingsOpen() && (state.settingsTab === 'mail' || state.settingsTab === 'general')) {
      if (!(state.settingsTab === 'mail' && state.adding)) renderSettings();
    }
  }

  async function refreshDesktop() {
    if (!isDesktop) return;
    try {
      const next = await bridge.getState();
      applyDesktopState(next);
    } catch (err) {
      /* ignore */
    }
  }

  async function setDesktopSetting(key, value) {
    try {
      const next = await bridge.setSetting(key, value);
      applyDesktopState(next);
    } catch (err) {
      showToast(t('err.unknown'));
    }
  }

  function readForm() {
    const providerSelect = $('#acc-provider');
    if (!providerSelect) return state.form;
    const secureInput = $('#acc-secure');
    state.form = {
      providerId: providerSelect.value,
      email: $('#acc-email').value.trim(),
      secret: $('#acc-secret').value,
      host: $('#acc-host').value.trim(),
      port: $('#acc-port').value.trim(),
      secure: secureInput ? secureInput.checked : true,
    };
    return state.form;
  }

  function validateForm() {
    const form = readForm();
    if (!form.email || form.email.indexOf('@') < 1 || !form.secret || !form.host) {
      showToast(t('err.invalid'));
      return null;
    }
    return {
      providerId: form.providerId,
      email: form.email,
      secret: form.secret,
      host: form.host,
      port: Number(form.port) || 993,
      secure: form.secure,
    };
  }

  async function saveAccount() {
    if (!isDesktop || state.busy) return;
    const payload = validateForm();
    if (!payload) return;
    state.busy = true;
    renderSettings();
    try {
      const result = await bridge.addAccount(payload);
      if (result && result.ok) {
        state.adding = false;
        state.form = { providerId: '', email: '', secret: '', host: '', port: '', secure: true };
        state.testResult = null;
        showToast(t('toast.saved'));
        applyDesktopState(result.state);
      } else {
        state.testResult = { ok: false, error: (result && result.error) || { code: 'err.unknown' } };
      }
    } catch (err) {
      state.testResult = { ok: false, error: { code: 'err.unknown' } };
    } finally {
      state.busy = false;
      renderSettings();
    }
  }

  async function testAccount() {
    if (!isDesktop || state.busy) return;
    const payload = validateForm();
    if (!payload) return;
    state.busy = true;
    state.testResult = null;
    renderSettings();
    try {
      const result = await bridge.testAccount(payload);
      state.testResult = result && result.ok
        ? { ok: true, unread: result.unread }
        : { ok: false, error: (result && result.error) || { code: 'err.unknown' } };
    } catch (err) {
      state.testResult = { ok: false, error: { code: 'err.unknown' } };
    } finally {
      state.busy = false;
      renderSettings();
    }
  }

  async function removeAccount(id) {
    if (!isDesktop) return;
    try {
      const next = await bridge.removeAccount(id);
      applyDesktopState(next);
      renderSettings();
    } catch (err) {
      showToast(t('err.unknown'));
    }
  }

  async function checkNow() {
    if (!isDesktop) return;
    showToast(t('toast.checking'));
    try {
      const next = await bridge.checkNow();
      applyDesktopState(next);
    } catch (err) {
      showToast(t('err.unknown'));
    }
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Events                                                       */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    els.q.addEventListener('input', () => {
      state.query = els.q.value;
      els.search.classList.toggle('has-value', state.query.length > 0);
      els.clear.hidden = state.query.length === 0;
      renderContent();
    });

    els.q.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const first = els.content.querySelector('.card-link');
        if (first) first.click();
      } else if (event.key === 'ArrowDown') {
        const first = els.content.querySelector('.card-link');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      } else if (event.key === 'Escape' && els.q.value) {
        resetSearch();
      }
    });

    els.clear.addEventListener('click', () => {
      resetSearch();
      els.q.focus();
    });

    els.filters.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter || 'all';
      renderChips();
      renderContent();
    });

    els.content.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]');
      if (action && action.dataset.action === 'reset') {
        resetAll();
        return;
      }
      const star = event.target.closest('.star');
      if (star) {
        event.preventDefault();
        toggleFavorite(star.dataset.fav);
        return;
      }
      const link = event.target.closest('[data-open]');
      if (link) recordOpen(link.dataset.open);
    });

    els.recentsList.addEventListener('click', (event) => {
      const link = event.target.closest('[data-open]');
      if (link) recordOpen(link.dataset.open);
    });

    els.settingsToggle.addEventListener('click', () => openSettings('general'));
    els.settingsClose.addEventListener('click', closeSettings);
    els.settings.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) closeSettings();
    });

    els.tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      state.settingsTab = tab.dataset.tab;
      state.adding = false;
      state.testResult = null;
      renderSettings();
    });

    els.body.addEventListener('click', (event) => {
      const target = event.target;

      const langButton = target.closest('[data-lang]');
      if (langButton) {
        applyLanguage(langButton.dataset.lang, true);
        renderAll();
        return;
      }

      const themeButton = target.closest('[data-theme-mode]');
      if (themeButton) {
        applyThemeMode(themeButton.dataset.themeMode, true);
        renderSettings();
        return;
      }

      const action = target.closest('[data-act]');
      if (!action) return;

      switch (action.dataset.act) {
        case 'add-account':
          state.adding = true;
          state.testResult = null;
          state.form = { providerId: '', email: '', secret: '', host: '', port: '', secure: true };
          renderSettings();
          break;
        case 'cancel-account':
          state.adding = false;
          state.testResult = null;
          renderSettings();
          break;
        case 'test-account':
          testAccount();
          break;
        case 'save-account':
          saveAccount();
          break;
        case 'remove-account':
          removeAccount(action.dataset.id);
          break;
        case 'clear-history':
          clearHistory();
          break;
        default:
          break;
      }
    });

    els.body.addEventListener('change', (event) => {
      const target = event.target;

      const setting = target.closest('[data-setting]');
      if (setting) {
        const key = setting.dataset.setting;
        if (key === 'autoStart' || key === 'startMinimized') {
          setDesktopSetting(key, setting.checked);
          return;
        }
        if (key === 'mailEnabled') {
          setDesktopSetting('mailEnabled', setting.checked);
          return;
        }
        if (key === 'interval') {
          setDesktopSetting('intervalMinutes', Number(setting.value));
          return;
        }
        if (key === 'secure') {
          readForm();
          return;
        }
      }

      if (target.id === 'acc-provider') {
        const provider = providerById.get(target.value);
        state.form.providerId = target.value;
        const preset = provider && provider.imap;
        if (preset) {
          state.form.host = preset.host;
          state.form.port = String(preset.port);
          state.form.secure = preset.secure !== false;
        }
        state.testResult = null;
        renderSettings();
      }
    });

    els.body.addEventListener('input', (event) => {
      if (event.target.id && event.target.id.indexOf('acc-') === 0) readForm();
    });

    els.langToggle.addEventListener('click', () => {
      applyLanguage(state.lang === 'zh' ? 'en' : 'zh', true);
      renderAll();
    });

    els.themeToggle.addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      applyThemeMode(dark ? 'light' : 'dark', true);
      if (isSettingsOpen()) renderSettings();
    });

    els.mailCheck.addEventListener('click', checkNow);
    els.mailSetup.addEventListener('click', () => openSettings('mail'));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isSettingsOpen()) {
        closeSettings();
        return;
      }
      trapFocus(event);

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === '/' && !typing && !isSettingsOpen()) {
        event.preventDefault();
        els.q.focus();
        els.q.select();
      }
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemTheme = () => {
      if (state.themeMode === 'system') {
        applyThemeMode('system', false);
        if (isSettingsOpen()) renderSettings();
      }
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemTheme);
    else if (typeof media.addListener === 'function') media.addListener(onSystemTheme);
  }

  function resetSearch() {
    state.query = '';
    els.q.value = '';
    els.search.classList.remove('has-value');
    els.clear.hidden = true;
    renderContent();
  }

  /** Offline support for the web build; Electron loads file:// and must not register a service worker */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const protocol = window.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  function resetAll() {
    resetSearch();
    state.filter = 'all';
    renderChips();
    renderContent();
    els.q.focus();
  }

  /* ------------------------------------------------------------------ */
  /* ---------- Render pipeline                                          */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    applyStaticI18n();
    renderHero();
    renderChips();
    renderRecents();
    renderContent();
    renderMailBar();
    if (isSettingsOpen()) renderSettings();
  }

  function init() {
    els.heroSubtitle = $('#hero-subtitle');
    els.q = $('#q');
    els.clear = $('#clear');
    els.search = $('.search');
    els.filters = $('#filters');
    els.content = $('#content');
    els.recents = $('#recents');
    els.recentsList = $('#recents-list');
    els.themeToggle = $('#theme-toggle');
    els.langToggle = $('#lang-toggle');
    els.settingsToggle = $('#settings-toggle');
    els.settings = $('#settings');
    els.settingsClose = $('#settings-close');
    els.tabs = $('#settings-tabs');
    els.body = $('#settings-body');
    els.toast = $('#toast');
    els.hint = $('#hint');
    els.mailbar = $('#mailbar');
    els.mailbarText = $('#mailbar-text');
    els.mailCheck = $('#mail-check');
    els.mailSetup = $('#mail-setup');

    if (!els.q || !els.content) return;

    const savedLang = readRaw(STORE.lang, '');
    const initialLang = savedLang === 'zh' || savedLang === 'en'
      ? savedLang
      : (navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    applyLanguage(initialLang, false);

    const savedMode = readRaw(STORE.themeMode, 'system');
    applyThemeMode(savedMode, false);

    state.favs = new Set(readJson(STORE.favs, []).filter(knownId));
    state.recent = readJson(STORE.recent, []).filter(knownId).slice(0, LIMITS.recent);

    const history = readJson(STORE.history, {});
    state.history = {};
    Object.keys(history || {}).forEach((id) => {
      if (!knownId(id)) return;
      const entry = history[id];
      if (entry && typeof entry === 'object' && typeof entry.lastAt === 'number') {
        state.history[id] = { count: Number(entry.count) || 1, lastAt: entry.lastAt };
      }
    });

    renderAll();
    bindEvents();
    registerServiceWorker();

    if (isDesktop) {
      refreshDesktop();
      if (bridge.onState) {
        bridge.onState((next) => applyDesktopState(next));
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
