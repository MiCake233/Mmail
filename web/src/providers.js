/*!
 * Mmail · provider catalogue
 * ---------------------------------------------------------------------------
 * Adding a provider = appending one object to PROVIDERS. `npm run check`
 * validates every field.
 *
 * Fields
 *   id        unique slug, lowercase letters / digits / hyphen
 *   name      Chinese display name
 *   nameEn    English display name, must be unique
 *   domain    host shown under the name
 *   url       official sign-in page, https only
 *   region    'cn' or 'intl'
 *   biz       true for business / work mailboxes
 *   color     tile colour (#rrggbb), an approximation of the brand colour
 *   ink       optional tile text colour, defaults to white
 *   mark      1-4 character monogram shown on the tile
 *   note      tooltip, { zh, en }
 *   keywords  extra search aliases
 *   imap      optional preset for mail alerts:
 *             { host, port, secure, mode: 'password'|'app-password'|'oauth', help }
 *             mode 'oauth' means the provider no longer accepts password sign-in,
 *             so alerts are unavailable; omitting `imap` means no preset and the
 *             user enters the server manually.
 *
 * Brand names and trademarks belong to their respective owners. This project
 * ships no provider logos: tiles are generated from a colour and a text
 * monogram, and colours are approximations rather than official brand codes.
 */
(function (global) {
  'use strict';

  /**
   * @typedef {Object} ProviderImap
   * @property {string} host
   * @property {number} port
   * @property {boolean} [secure]
   * @property {'password'|'app-password'|'oauth'} mode
   * @property {string} [help] where to obtain an app password
   */

  /**
   * @typedef {Object} MailProvider
   * @property {string} id
   * @property {string} name
   * @property {string} nameEn
   * @property {string} domain
   * @property {string} url
   * @property {'cn'|'intl'} region
   * @property {boolean} [biz]
   * @property {string} color
   * @property {string} [ink]
   * @property {string} mark
   * @property {{ zh: string, en: string }} note
   * @property {string[]} keywords
   * @property {ProviderImap} [imap]
   */

  /** @type {MailProvider[]} */
  const PROVIDERS = [
    /* ------------------------- China ------------------------- */
    {
      id: 'qq',
      name: 'QQ邮箱',
      nameEn: 'QQ Mail',
      domain: 'mail.qq.com',
      url: 'https://mail.qq.com/',
      region: 'cn',
      color: '#12B7F5',
      mark: 'QQ',
      note: { zh: 'QQ 账号登录 / 微信扫码', en: 'Sign in with QQ or WeChat QR' },
      keywords: ['qq', 'qqmail', 'tencent', '腾讯', '微信', 'foxmail'],
      imap: {
        host: 'imap.qq.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://service.mail.qq.com/detail/0/75',
      },
    },
    {
      id: 'exmail',
      name: '腾讯企业邮',
      nameEn: 'Tencent Exmail',
      domain: 'exmail.qq.com',
      url: 'https://exmail.qq.com/',
      region: 'cn',
      biz: true,
      color: '#2F6BFF',
      mark: 'EX',
      note: { zh: '腾讯企业邮箱（Exmail）', en: 'Tencent enterprise mailbox' },
      keywords: ['exmail', 'tencent', '腾讯', '企业', '企业邮箱', '办公'],
      imap: { host: 'imap.exmail.qq.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'netease163',
      name: '网易163邮箱',
      nameEn: 'NetEase 163 Mail',
      domain: 'mail.163.com',
      url: 'https://mail.163.com/',
      region: 'cn',
      color: '#E33A3A',
      mark: '163',
      note: { zh: '网易免费邮箱', en: 'NetEase free mailbox' },
      keywords: ['163', 'netease', '网易', '免费邮箱'],
      imap: {
        host: 'imap.163.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2',
      },
    },
    {
      id: 'netease126',
      name: '网易126邮箱',
      nameEn: 'NetEase 126 Mail',
      domain: 'mail.126.com',
      url: 'https://mail.126.com/',
      region: 'cn',
      color: '#C9302C',
      mark: '126',
      note: { zh: '网易免费邮箱', en: 'NetEase free mailbox' },
      keywords: ['126', 'netease', '网易', '免费邮箱'],
      imap: { host: 'imap.126.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'yeah',
      name: '网易yeah邮箱',
      nameEn: 'NetEase Yeah Mail',
      domain: 'mail.yeah.net',
      url: 'https://mail.yeah.net/',
      region: 'cn',
      color: '#F58220',
      ink: '#2E1600',
      mark: 'yeah',
      note: { zh: '网易免费邮箱（yeah.net）', en: 'NetEase free mailbox (yeah.net)' },
      keywords: ['yeah', 'netease', '网易', 'yeah.net', '免费邮箱'],
      imap: { host: 'imap.yeah.net', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'qiye163',
      name: '网易企业邮箱',
      nameEn: 'NetEase Enterprise Mail',
      domain: 'qiye.163.com',
      url: 'https://qiye.163.com/login/',
      region: 'cn',
      biz: true,
      color: '#C4162A',
      mark: '企',
      note: { zh: '网易企业邮箱登录入口', en: 'NetEase enterprise mailbox portal' },
      keywords: ['qiye', 'netease', '网易', '企业', '企业邮箱', '办公'],
      imap: { host: 'imap.qiye.163.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'aliyun',
      name: '阿里邮箱',
      nameEn: 'Alibaba Mail',
      domain: 'mail.aliyun.com',
      url: 'https://mail.aliyun.com/',
      region: 'cn',
      color: '#FF6A00',
      mark: '阿里',
      note: { zh: '阿里个人邮箱 / 阿里企业邮箱', en: 'Alibaba personal & enterprise mail' },
      keywords: ['aliyun', '阿里云', 'alibaba', '阿里', '万网'],
      imap: { host: 'imap.aliyun.com', port: 993, secure: true, mode: 'password' },
    },
    {
      id: 'sina',
      name: '新浪邮箱',
      nameEn: 'Sina Mail',
      domain: 'mail.sina.com.cn',
      url: 'https://mail.sina.com.cn/',
      region: 'cn',
      color: '#D7232A',
      mark: 'sina',
      note: { zh: '新浪免费邮箱', en: 'Sina free mailbox' },
      keywords: ['sina', '新浪', 'sina.com'],
      imap: {
        host: 'imap.sina.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://mail.sina.com.cn/help/',
      },
    },
    {
      id: 'sohu',
      name: '搜狐邮箱',
      nameEn: 'Sohu Mail',
      domain: 'mail.sohu.com',
      url: 'https://mail.sohu.com/',
      region: 'cn',
      color: '#FFC53D',
      ink: '#3E2A00',
      mark: 'sohu',
      note: { zh: '搜狐免费邮箱', en: 'Sohu free mailbox' },
      keywords: ['sohu', '搜狐'],
    },
    {
      id: 'cm139',
      name: '139邮箱',
      nameEn: 'China Mobile 139 Mail',
      domain: 'mail.10086.cn',
      url: 'https://mail.10086.cn/',
      region: 'cn',
      color: '#0A6ED1',
      mark: '139',
      note: { zh: '中国移动 139 邮箱', en: 'China Mobile 139 mailbox' },
      keywords: ['139', '10086', '移动', '中国移动', 'china mobile'],
    },
    {
      id: 'ct189',
      name: '189邮箱',
      nameEn: 'China Telecom 189 Mail',
      domain: 'mail.189.cn',
      url: 'https://mail.189.cn/',
      region: 'cn',
      color: '#0087C9',
      mark: '189',
      note: { zh: '中国电信 189 邮箱（天翼）', en: 'China Telecom 189 mailbox' },
      keywords: ['189', '电信', '中国电信', '天翼', 'china telecom'],
      imap: { host: 'imap.189.cn', port: 993, secure: true, mode: 'password' },
    },
    {
      id: 'wo',
      name: '沃邮箱',
      nameEn: 'China Unicom Wo Mail',
      domain: 'mail.wo.cn',
      url: 'https://mail.wo.cn/',
      region: 'cn',
      color: '#E60012',
      mark: '沃',
      note: { zh: '中国联通沃邮箱', en: 'China Unicom Wo mailbox' },
      keywords: ['wo', '联通', '中国联通', 'unicom', '沃'],
    },
    {
      id: 'cn21',
      name: '21CN邮箱',
      nameEn: '21CN Mail',
      domain: 'mail.21cn.com',
      url: 'https://mail.21cn.com/',
      region: 'cn',
      color: '#0B67B2',
      mark: '21CN',
      note: { zh: '21CN 免费邮箱', en: '21CN free mailbox' },
      keywords: ['21cn', '21'],
    },

    /* ------------------------- International ------------------------- */
    {
      id: 'gmail',
      name: 'Gmail',
      nameEn: 'Gmail',
      domain: 'mail.google.com',
      url: 'https://mail.google.com/',
      region: 'intl',
      color: '#EA4335',
      mark: 'G',
      note: { zh: 'Google 邮箱', en: 'Google mailbox' },
      keywords: ['gmail', 'google', '谷歌', '谷歌邮箱'],
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://support.google.com/accounts/answer/185833',
      },
    },
    {
      id: 'outlook',
      name: 'Outlook',
      nameEn: 'Outlook',
      domain: 'outlook.live.com',
      url: 'https://outlook.live.com/mail/',
      region: 'intl',
      color: '#0F6CBD',
      mark: 'O',
      note: { zh: '微软个人邮箱：Outlook / Hotmail / Live', en: 'Microsoft personal mail: Outlook / Hotmail / Live' },
      keywords: ['outlook', 'hotmail', 'live', 'microsoft', '微软'],
      imap: { host: 'outlook.office365.com', port: 993, secure: true, mode: 'oauth' },
    },
    {
      id: 'm365',
      name: 'Microsoft 365',
      nameEn: 'Microsoft 365',
      domain: 'outlook.office.com',
      url: 'https://outlook.office.com/mail/',
      region: 'intl',
      biz: true,
      color: '#0364B8',
      mark: '365',
      note: { zh: '工作或学校账号（Office 365）', en: 'Work or school account (Office 365)' },
      keywords: ['microsoft365', 'office365', '365', 'microsoft', '微软', '工作', '学校'],
      imap: { host: 'outlook.office365.com', port: 993, secure: true, mode: 'oauth' },
    },
    {
      id: 'yahoo',
      name: 'Yahoo Mail',
      nameEn: 'Yahoo Mail',
      domain: 'mail.yahoo.com',
      url: 'https://mail.yahoo.com/',
      region: 'intl',
      color: '#6001D2',
      mark: 'Y',
      note: { zh: 'Yahoo 邮箱', en: 'Yahoo mailbox' },
      keywords: ['yahoo', '雅虎'],
      imap: {
        host: 'imap.mail.yahoo.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://help.yahoo.com/kb/generate-manage-third-party-passwords-sln15241.html',
      },
    },
    {
      id: 'icloud',
      name: 'iCloud Mail',
      nameEn: 'iCloud Mail',
      domain: 'icloud.com',
      url: 'https://www.icloud.com/mail/',
      region: 'intl',
      color: '#3693F3',
      mark: 'iC',
      note: { zh: 'Apple iCloud 邮箱', en: 'Apple iCloud mailbox' },
      keywords: ['icloud', 'apple', '苹果', 'me.com'],
      imap: {
        host: 'imap.mail.me.com',
        port: 993,
        secure: true,
        mode: 'app-password',
        help: 'https://support.apple.com/zh-cn/102654',
      },
    },
    {
      id: 'proton',
      name: 'Proton Mail',
      nameEn: 'Proton Mail',
      domain: 'mail.proton.me',
      url: 'https://mail.proton.me/',
      region: 'intl',
      color: '#6D4AFF',
      mark: 'P',
      note: { zh: '端到端加密邮箱', en: 'End-to-end encrypted mailbox' },
      keywords: ['proton', 'protonmail', '加密', '隐私'],
    },
    {
      id: 'zoho',
      name: 'Zoho Mail',
      nameEn: 'Zoho Mail',
      domain: 'mail.zoho.com',
      url: 'https://mail.zoho.com/',
      region: 'intl',
      biz: true,
      color: '#E42527',
      mark: 'Z',
      note: { zh: '自定义域名 / 企业邮箱', en: 'Custom domain / business mail' },
      keywords: ['zoho', '企业', '域名邮箱', '自定义域名'],
      imap: { host: 'imap.zoho.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'gmx',
      name: 'GMX',
      nameEn: 'GMX Mail',
      domain: 'mail.gmx.com',
      url: 'https://mail.gmx.com/',
      region: 'intl',
      color: '#1C449B',
      mark: 'GMX',
      note: { zh: '德国 GMX 邮箱', en: 'German GMX mailbox' },
      keywords: ['gmx', '德国', 'germany'],
      imap: { host: 'imap.gmx.com', port: 993, secure: true, mode: 'password' },
    },
    {
      id: 'aol',
      name: 'AOL Mail',
      nameEn: 'AOL Mail',
      domain: 'mail.aol.com',
      url: 'https://mail.aol.com/',
      region: 'intl',
      color: '#2E77D0',
      mark: 'AOL',
      note: { zh: 'AOL 邮箱', en: 'AOL mailbox' },
      keywords: ['aol', '美国'],
      imap: { host: 'imap.aol.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'yandex',
      name: 'Yandex Mail',
      nameEn: 'Yandex Mail',
      domain: 'mail.yandex.com',
      url: 'https://mail.yandex.com/',
      region: 'intl',
      color: '#FC3F1D',
      mark: 'Я',
      note: { zh: 'Yandex 邮箱', en: 'Yandex mailbox' },
      keywords: ['yandex', 'яндекс', '俄罗斯'],
      imap: { host: 'imap.yandex.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'mailru',
      name: 'Mail.ru',
      nameEn: 'Mail.ru',
      domain: 'e.mail.ru',
      url: 'https://e.mail.ru/',
      region: 'intl',
      color: '#005FF9',
      mark: '@',
      note: { zh: 'Mail.ru 邮箱', en: 'Mail.ru mailbox' },
      keywords: ['mailru', 'mail.ru', '俄罗斯'],
      imap: { host: 'imap.mail.ru', port: 993, secure: true, mode: 'password' },
    },
    {
      id: 'fastmail',
      name: 'Fastmail',
      nameEn: 'Fastmail',
      domain: 'app.fastmail.com',
      url: 'https://app.fastmail.com/',
      region: 'intl',
      color: '#0B5CD5',
      mark: 'F',
      note: { zh: '自定义域名付费邮箱', en: 'Paid mailbox with custom domain' },
      keywords: ['fastmail', '域名邮箱', '付费'],
      imap: { host: 'imap.fastmail.com', port: 993, secure: true, mode: 'app-password' },
    },
    {
      id: 'tuta',
      name: 'Tuta Mail',
      nameEn: 'Tuta Mail',
      domain: 'app.tuta.com',
      url: 'https://app.tuta.com/',
      region: 'intl',
      color: '#9E1B32',
      mark: 'T',
      note: { zh: 'Tuta（原 Tutanota）加密邮箱', en: 'Tuta (formerly Tutanota) encrypted mail' },
      keywords: ['tuta', 'tutanota', '加密', '隐私'],
    },
    {
      id: 'naver',
      name: 'Naver Mail',
      nameEn: 'Naver Mail',
      domain: 'mail.naver.com',
      url: 'https://mail.naver.com/',
      region: 'intl',
      color: '#03C75A',
      mark: 'N',
      note: { zh: '韩国 Naver 邮箱', en: 'Korean Naver mailbox' },
      keywords: ['naver', '韩国', 'korea'],
      imap: { host: 'imap.naver.com', port: 993, secure: true, mode: 'app-password' },
    },
  ];

  /**
   * Filter categories. 'fav' is the local favorites list, resolved by app.js.
   * @type {{ id: string, key: string }[]}
   */
  const CATEGORIES = [
    { id: 'all', key: 'filter.all' },
    { id: 'cn', key: 'filter.cn' },
    { id: 'intl', key: 'filter.intl' },
    { id: 'biz', key: 'filter.biz' },
    { id: 'fav', key: 'filter.fav' },
  ];

  global.MmailData = { PROVIDERS, CATEGORIES };
})(typeof window !== 'undefined' ? window : globalThis);
