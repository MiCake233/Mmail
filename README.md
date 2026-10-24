# Mmail

**Status: beta** · version `0.1.0-beta.5` · MIT

A mail sign-in launcher. Mmail collects the official sign-in pages of 27 mainstream mail providers into one searchable page, and can optionally poll a mailbox over IMAP and raise a desktop notification. It ships as an Electron desktop application, a static web build, and an Android shell.

> 中文简介见下方 **中文简介** 一节。
> A Chinese introduction follows the English text below.

## Download

Prebuilt binaries are attached to the [releases](https://github.com/MiCake233/Mmail/releases):

- **Windows** — `Mmail-<version>-win-x64.zip`: portable, no installer. Unpack and run `Mmail.exe`.
- **macOS** — `Mmail-<version>-mac-<arch>.dmg` and `.zip`: unsigned build, see the note below.
- **Linux** — `Mmail-<version>-linux-<arch>.AppImage` and `.deb`.
- **Android** — `Mmail-<version>-android.apk`: debug-signed, sideload only.

All builds are beta. The Android package runs the same interface as the desktop and web builds;
background mail alerts are not part of it yet (see the Android section below).

The macOS package is not signed or notarised. On first launch, open it from the context menu
(*Open*) or allow it in *System Settings → Privacy & Security*. Without a Developer ID the
Gatekeeper warning cannot be avoided honestly.

## Scope and legal position

- Mmail does not host, proxy, embed, or render any provider's mailbox or sign-in form. Every entry is a plain hyperlink to the provider's own public sign-in URL; the click is handed to the system browser.
- No provider logos are bundled. Entries are drawn as a locally generated coloured tile with a short text monogram. Colour values approximate brand colours to aid recognition; they are not official brand codes.
- Mmail is not affiliated with, endorsed by, or sponsored by any mail provider. Provider names and trademarks belong to their respective owners.
- There is no backend, no account system, and no telemetry. Web credentials are never requested, captured, or stored; authentication happens entirely on the provider's page.
- Mail alerts require the user to supply an IMAP app password for their own mailbox. The credential is encrypted with the operating system keystore and used only for local, read-only IMAP checks.

## Beta disclaimer

Mail alerts depend on third-party IMAP servers and on network conditions outside the control of this project. Notifications can be delayed, merged, or missed, and the client can incorrectly report that no new mail exists. Mmail is not a mail delivery service and offers no delivery guarantee. Do not use it as the only notification channel for important or time-critical mail. The authors accept no liability for missed, delayed, or lost messages, or for any consequence of relying on this software.

## Features

- 27 providers: 13 China, 14 international, plus business-mailbox filtering.
- Unread indicator: a red dot on the provider tile when a connected mailbox reports unread mail; opening the entry clears it.
- One-step alert setup: the bell on a tile opens the account form with the provider preselected, and the IMAP host is inferred from the address you type.
- Search by Chinese name, English name, domain, or alias; favourites, recents, and a local login history.
- Light and dark themes (system-following by default) and a bilingual interface (Chinese / English).
- Desktop: tray residency, launch at login, native notifications that open the provider's webmail on click.
- Keyboard: `/` focuses search, `↑` / `↓` moves between entries, `Enter` opens, `Esc` closes panels.
- Embedded browser: mail pages open inside the application in a sandboxed view, with back, forward, reload and a one-click switch to the system browser.
- Web build: static files; a service worker caches the shell so the launcher opens offline.

## Platform support

| Platform | Package | Launch at login | Notes |
| --- | --- | --- | --- |
| Windows 10/11 x64 | portable zip | Run key (`HKCU\…\Run`) | Tray, native notifications |
| macOS 12+ (arm64 / x64) | dmg, zip | Login Items | Unsigned; allow on first launch |
| Linux x64 | AppImage, deb | XDG autostart entry (`~/.config/autostart/mmail.desktop`) | Needs libsecret for credential encryption, libnotify for notifications, libappindicator for the tray |
| Android 7+ | apk | — | WebView shell; alerts are desktop-only |

On Linux without a Secret Service (gnome-keyring or KWallet), Electron cannot encrypt the IMAP
credential. Mmail then stores it Base64-encoded and flags the account in the settings list;
install `libsecret` and a keyring to avoid that fallback.

## Requirements

- Node.js 18 or newer, plus npm, for the desktop and web builds.
- A modern browser for the web build.
- For Android: Android Studio (see `android/README.md`).

## Install and run

```bash
git clone https://github.com/MiCake233/Mmail.git
cd Mmail
npm install
npm start        # desktop application
npm run web      # web build at http://127.0.0.1:5173
```

If the Electron binary download fails behind a restrictive network, set a mirror before installing:

```bash
# macOS / Linux
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
# Windows PowerShell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm install
```

## Embedded browser

Desktop builds open provider pages in an embedded browser instead of handing every click to the system browser.

- The page runs in its own `WebContentsView`: no preload, no Node integration, `sandbox: true`.
- Cookies and sessions live in a dedicated persistent partition (`persist:mmail-browser`) under the app's user data, so a signed-in mailbox stays signed in across restarts. Nothing is uploaded.
- Camera, microphone, geolocation and similar permission requests from the page are denied.
- OAuth popups still work: `window.open` creates a real child window sharing the same partition.
- The toolbar offers back, forward, reload, *Open in system browser* and *Close*.

Some providers refuse sign-in from an embedded browser. Google and Microsoft treat it as an insecure client and may answer with "this browser or app may not be secure"; Gmail, Outlook, Microsoft 365, Yahoo, iCloud and Proton show a warning in the toolbar and keep the system-browser fallback one click away. Settings → General → *Where links open* switches the default for every provider.

## Mail alerts

Alerts use IMAP with an app password, never the account password.

| Provider | Requirement |
| --- | --- |
| QQ Mail | Enable IMAP/SMTP in the web settings, then generate an authorization code |
| NetEase 163 / 126 / yeah | Enable IMAP, then obtain an authorization code |
| Gmail | Enable two-step verification, then create an app password |
| iCloud | Create an app-specific password for the Apple ID |
| Yahoo / AOL / Zoho / Fastmail / Yandex / Naver | Generate an app password in the security settings |
| Outlook / Microsoft 365 | Password sign-in is disabled (OAuth only); alerts are unsupported and the UI states so |

Open **Settings → Mail alerts → Add account**. Selecting a provider pre-fills the IMAP host and port; the connection is tested before the account is stored.

Implementation constraints:

- Only `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]` is fetched. Bodies are not downloaded and messages are not marked as read.
- The first connection records a baseline UID, so existing mail never triggers alerts.
- At most three messages per account are summarised in one notification.
- NetEase servers require the IMAP `ID` extension; it is sent before `SELECT`.

## Privacy and security

- No network activity other than the IMAP connections the user configures and the provider pages the user opens.
- App passwords are encrypted with Electron `safeStorage` (DPAPI / Keychain / Secret Service) and written to `mmail.json` in the application's userData directory. When OS encryption is unavailable the value is stored Base64-encoded and flagged in the record.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, and can only call the whitelisted preload bridge.
- In-app navigation to external origins is blocked; links are opened by the system browser.
- Local usage data (favourites, history, theme, language) stays in `localStorage`.

## Architecture

```
mmail/
├─ electron/         main process: window, tray, launch at login, IPC, notifications,
│                    minimal IMAP client, encrypted settings store
├─ web/              renderer shared by desktop, web, and the Android shell
│  ├─ src/providers.js   provider catalogue (single data source)
│  ├─ src/locales.js     Chinese and English UI strings
│  ├─ src/i18n.js        translation factory
│  ├─ src/app.js         interface logic
│  └─ src/styles.css     light and dark themes
├─ android/          WebView shell that bundles web/ as assets
├─ scripts/          self-check, static server, IMAP and storage tests, icon generator
└─ assets/           application icons generated from the master artwork
```

The renderer contains no framework and no build step. Desktop capabilities arrive through `window.mmail`, which the preload script injects; when it is absent the same code runs as a plain web page with entries, favourites, and history only.

## Development

```bash
npm start           # desktop
npm run dev         # desktop with DevTools
npm run web         # web build
npm run check       # static self-check: syntax, catalogue, locales, markup, comments
npm run test:imap   # IMAP client regression test against a local fake server
npm run test:store  # storage and OS-encryption smoke test, runs inside Electron
npm run icons       # regenerate icons from assets/icon-source.jpg
npm run build:win   # assemble dist/Mmail-<version>-win-x64.zip (portable)
npm run dist        # electron-builder: zip / dmg / AppImage / deb into release/
```

`npm run check` also fails when a source comment is not in English. Locale data (`locales.js`, the `zh` tables in `electron/strings.js`) is exempt.

## Known limitations

- The embedded browser is desktop-only; the web and Android builds hand links to the system browser.
- Google and Microsoft may block sign-in inside the embedded view; use the system-browser action for those accounts.

- The Android target is a WebView shell. Background mail alerts are not implemented; the UI states that alerts require the desktop build.
- Providers without an IMAP preset require the user to enter a host and port.
- Outlook and Microsoft 365 cannot be used for alerts until OAuth is implemented.
- Mmail does not send, read, search, or organise mail; it opens pages and reports new-mail headers.

## Roadmap

- Android background alerts (WorkManager, native IMAP, notification channel).
- OAuth for Microsoft mailboxes, if a dependency-free implementation is practical.
- Packaged installers via electron-builder.

## License

MIT. See [LICENSE](./LICENSE).

---

# 中文简介

**状态：测试版（beta）** · 版本 `0.1.0-beta.5` · MIT

Mmail 是一个邮箱登录入口启动器。它把 27 家主流邮箱的官方登录页汇总到一页，可搜索、可筛选；桌面版可选地通过 IMAP 轮询收件箱并弹出系统通知。项目同时提供 Electron 桌面应用、静态网页版与安卓外壳。

## 下载

预编译版本见 [Releases](https://github.com/MiCake233/Mmail/releases)：

- **Windows** — `Mmail-<version>-win-x64.zip`：便携版，无需安装，解压后运行 `Mmail.exe`。
- **macOS** — `Mmail-<version>-mac-<arch>.dmg` 与 `.zip`：未签名版本，见下方说明。
- **Linux** — `Mmail-<version>-linux-<arch>.AppImage` 与 `.deb`。
- **Android** — `Mmail-<version>-android.apk`：调试签名，需手动安装。

所有构建均为测试版。安卓包与桌面版、网页版使用同一套界面；后台收件提醒尚未包含在内（见下文“安卓端”）。

macOS 包未签名、未公证。首次打开请在右键菜单中选择「打开」，或在「系统设置 → 隐私与安全性」中放行。
没有 Developer ID 的情况下，Gatekeeper 提示无法回避。

## 范围与法律定位

- 不托管、不代理、不内嵌任何邮箱的收件箱或登录表单。每个条目只是一个指向服务商官方公开登录地址的普通超链接，点击后交由系统浏览器打开。
- 不打包任何服务商 logo。条目由本地生成的色块与文字字标组成；颜色仅用于辅助识别，为近似值而非官方品牌色。
- 与任何邮箱服务商均无隶属、背书或赞助关系。服务商名称与商标归各自所有者。
- 无后端、无账号体系、无统计上报。不请求、不采集、不保存网页登录凭据；认证完全发生在服务商页面。
- 收件提醒需要用户自行提供其邮箱的 IMAP 授权码（应用专用密码）。该凭据以操作系统密钥库加密保存，仅用于本机只读检查。

## 测试版声明

收件提醒依赖第三方 IMAP 服务，以及本项目不可控的网络条件。通知可能延迟、合并或漏发，客户端也可能错误地报告“没有新邮件”。Mmail 不是邮件投递服务，不提供任何送达保证。请勿将其作为重要或时效性邮件的唯一提醒渠道。对于漏发、延迟或丢失的邮件及其后果，作者不承担责任。

## 功能

- 27 家邮箱：国内 13 家、国际 14 家，并支持企业邮箱筛选。
- 未读提示：已连接账号有未读邮件时，对应入口图标右上角显示红点；打开该入口后清除。
- 一步开启提醒：卡片上的铃铛直接打开已预选服务商的添加表单，输入邮箱地址即自动匹配 IMAP 服务器。
- 可按中文名、英文名、域名或别名搜索；提供收藏、最近访问与本地登录记录。
- 明暗主题（默认跟随系统），中英双语界面。
- 桌面版：托盘常驻、开机自启动、系统通知（点击通知打开对应邮箱网页）。
- 键盘：`/` 聚焦搜索，`↑` / `↓` 在条目间移动，`Enter` 打开，`Esc` 关闭面板。
- 内置浏览器：邮件页面在应用内的沙箱视图中打开，支持后退、前进、刷新，并可一键改用系统浏览器。
- 网页版：纯静态文件，Service Worker 缓存外壳以支持离线打开。

## 平台支持

| 平台 | 安装包 | 开机自启动 | 说明 |
| --- | --- | --- | --- |
| Windows 10/11 x64 | 便携版 zip | 注册表 Run 项 | 托盘、系统通知 |
| macOS 12+（arm64 / x64） | dmg、zip | 登录项（Login Items） | 未签名，首次需放行 |
| Linux x64 | AppImage、deb | XDG 自启动项（`~/.config/autostart/mmail.desktop`） | 凭据加密需 libsecret，通知需 libnotify，托盘需 libappindicator |
| Android 7+ | apk | — | WebView 外壳，收件提醒仅桌面版 |

Linux 上若没有 Secret Service（gnome-keyring 或 KWallet），Electron 无法加密 IMAP 授权码。
此时 Mmail 以 Base64 保存，并在设置列表中标注该账号；安装 `libsecret` 与密钥环即可避免。

## 安装与运行

```bash
git clone https://github.com/MiCake233/Mmail.git
cd Mmail
npm install
npm start        # 桌面应用
npm run web      # 网页版，http://127.0.0.1:5173
```

若 Electron 二进制下载失败（受限网络环境），安装前设置镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm install
```

## 内置浏览器

桌面版把邮箱页面放在应用内的浏览器视图中打开，而不是每次点击都交给系统浏览器。

- 页面运行在独立的 `WebContentsView` 中：无 preload、无 Node 集成、`sandbox: true`。
- Cookie 与会话保存在独立持久分区（`persist:mmail-browser`，位于应用 userData 内），登录状态重启后保留；不会上传。
- 页面申请的摄像头、麦克风、定位等权限一律拒绝。
- OAuth 弹窗可用：`window.open` 会创建共享同一分区的真实子窗口。
- 工具栏提供后退、前进、刷新、改用系统浏览器、关闭。

部分服务商拒绝内嵌浏览器登录：Google 与微软会将其视为不安全客户端，可能返回「此浏览器或应用可能不安全」。Gmail、Outlook、Microsoft 365、Yahoo、iCloud、Proton 会在工具栏显示提示，系统浏览器出口一键可达。默认打开方式可在「设置 → 通用 → 链接打开方式」中切换。

## 收件提醒

提醒使用 IMAP 与授权码，不使用登录密码。

| 邮箱 | 需要做什么 |
| --- | --- |
| QQ 邮箱 | 网页设置中开启 IMAP/SMTP，生成授权码 |
| 网易 163 / 126 / yeah | 开启 IMAP，获取授权码 |
| Gmail | 开启两步验证，创建应用专用密码 |
| iCloud | 为 Apple ID 创建 App 专用密码 |
| Yahoo / AOL / Zoho / Fastmail / Yandex / Naver | 在安全设置中生成应用密码 |
| Outlook / Microsoft 365 | 官方已停用密码登录（仅 OAuth），不支持提醒，界面会明确标注 |

操作路径：**设置 → 收件提醒 → 添加账号**。选择服务商会自动填入 IMAP 地址与端口；保存前会先测试连接。

实现约束：

- 只取 `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]`，不下载正文，不标记已读。
- 首次连接只记录基线 UID，历史邮件不会触发提醒。
- 每个账号单次通知最多汇总三封邮件。
- 网易系服务器要求 IMAP `ID` 扩展，客户端在 `SELECT` 前发送。

## 隐私与安全

- 除用户自行配置的 IMAP 连接与用户打开的官方页面外，无其他网络行为。
- 授权码使用 Electron `safeStorage`（DPAPI / Keychain / Secret Service）加密后写入应用 userData 目录下的 `mmail.json`；系统加密不可用时以 Base64 保存并在记录中标记。
- 渲染层开启 `contextIsolation`、关闭 `nodeIntegration`，只能调用 preload 白名单方法。
- 应用窗口内阻止导航到外部来源，外链交由系统浏览器打开。
- 收藏、登录记录、主题与语言保存在本地 `localStorage`。

## 开发与自检

```bash
npm run check       # 静态自检：语法、邮箱数据、文案、结构、注释语言
npm run test:imap   # IMAP 客户端回归测试（本地假服务器）
npm run test:store  # 存储与系统加密冒烟测试（在 Electron 内运行）
npm run icons       # 从 assets/icon-source.jpg 重新生成图标
npm run build:win   # 生成 dist/Mmail-<version>-win-x64.zip（便携版）
npm run dist        # 使用 electron-builder 产出 zip / dmg / AppImage / deb 到 release/
```

`npm run check` 在源码注释不是英文时会失败；语言数据（`locales.js`、`electron/strings.js` 中的 `zh` 表）除外。

## 已知限制

- 内置浏览器仅桌面版可用；网页版与安卓版仍交给系统浏览器。
- Google 与微软可能拒绝内嵌视图内的登录，这类账号请改用系统浏览器。

- 安卓端为 WebView 外壳，后台收件提醒尚未实现，界面会明确提示需要桌面版。
- 没有 IMAP 预设的服务商需要手动填写服务器地址与端口。
- Outlook 与 Microsoft 365 在实现 OAuth 前无法用于提醒。
- Mmail 不发送、不阅读、不搜索、不整理邮件；它只打开页面并报告新邮件头信息。

## 许可

MIT，见 [LICENSE](./LICENSE)。
