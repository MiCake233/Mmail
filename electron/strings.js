'use strict';

/**
 * Mmail · main-process locale data
 * ---------------------------------------------------------------------------
 * Short strings used by native notifications and the tray menu. Interface copy
 * lives in web/src/locales.js; this file only carries the main-process subset.
 */

const NOTIFY = {
  zh: {
    title: '{name} · {count} 封新邮件',
    titleOne: '{name} · 1 封新邮件',
    unknownSender: '未知发件人',
    noSubject: '（无主题）',
    more: '另有 {count} 封',
  },
  en: {
    title: '{name} · {count} new messages',
    titleOne: '{name} · 1 new message',
    unknownSender: 'Unknown sender',
    noSubject: '(no subject)',
    more: '{count} more',
  },
};

const TRAY = {
  zh: { open: '打开 Mmail', check: '立即检查收件', auto: '开机自启动', quit: '退出' },
  en: { open: 'Open Mmail', check: 'Check mail now', auto: 'Launch at login', quit: 'Quit' },
};

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  );
}

module.exports = { NOTIFY, TRAY, fill };
