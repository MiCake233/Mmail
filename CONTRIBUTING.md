# Contributing

Mmail is intentionally small: no runtime dependencies, no build step, and the shipped interface is the source that runs. Run the checks before opening a pull request:

```bash
npm run check
npm run test:imap
```

## What is useful

- Adding a provider, or correcting a sign-in URL that has moved. Include the old and new address.
- Completing IMAP presets for providers whose host and port are documented and reachable.
- Fixing or clarifying UI copy. Both language tables must stay aligned.
- Interface work that respects both themes and narrow viewports.

## Adding a provider

Edit `web/src/providers.js` only:

```js
{
  id: 'example',                       // lowercase slug, unique
  name: '示例邮箱',
  nameEn: 'Example Mail',              // unique, shown when the UI is English
  domain: 'mail.example.com',
  url: 'https://mail.example.com/',     // official sign-in page, https only
  region: 'cn',                         // 'cn' or 'intl'
  color: '#3B82F6',                     // tile colour, approximate brand colour
  mark: 'EX',                           // 1-4 characters
  note: { zh: '示例邮箱', en: 'Example mailbox' },
  keywords: ['example', '示例'],         // optional search aliases
  imap: { host: 'imap.example.com', port: 993, secure: true, mode: 'app-password' },
}
```

`imap` may be omitted. `mode` is `password`, `app-password`, or `oauth`; `oauth` marks a provider that no longer accepts password sign-in and therefore cannot support alerts.

Then run `npm run check`, which validates the field set and the locale keys.

## Conventions

- **No runtime dependencies.** The renderer uses browser APIs only; the main process uses Electron and Node built-ins.
- **No provider logos.** Entries are a colour plus a short monogram. Do not add logo image files.
- **English source.** Code and comments are English. User-facing copy belongs in `web/src/locales.js` (both languages) or in the `zh` / `en` tables of `electron/strings.js`.
- **Links open outside the app.** Never embed a provider's sign-in form.
- **Commits** follow Conventional Commits, for example `feat: add Zoho China entry` or `fix: update 139 mailbox URL`.

## Pull request checklist

- [ ] `npm run check` and `npm run test:imap` pass
- [ ] New copy exists in both languages with identical placeholders
- [ ] A new or changed sign-in URL opens the provider's own sign-in page
- [ ] Screenshots are included for interface changes
