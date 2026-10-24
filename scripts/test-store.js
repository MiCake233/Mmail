'use strict';

/**
 * Mmail · storage smoke test
 * ---------------------------------------------------------------------------
 * Must run inside Electron (safeStorage provides OS-level encryption):
 *   npm run test:store
 *
 * Verifies:
 *   1. an account can be written and read back;
 *   2. the auth code is encrypted at rest and never appears in the snapshot
 *      handed to the renderer;
 *   3. decryption returns the original value.
 */

const { app } = require('electron');
const { Store } = require('../electron/store');

const SECRET = 'smoke-secret-code';

app.whenReady().then(async () => {
  try {
    const store = new Store();

    /* Remove accounts left behind by earlier runs. */
    store.data.accounts.slice().forEach((account) => store.removeAccount(account.id));

    const account = await store.addAccount({
      providerId: 'qq',
      email: 'smoke-test@example.com',
      host: 'imap.qq.com',
      port: 993,
      secure: true,
      secret: SECRET,
    });

    const connection = await store.connectionOf(account);
    const snapshot = store.snapshot({ checking: false, lastCheck: null });
    const serialized = JSON.stringify(snapshot);

    const results = {
      accountSaved: snapshot.mail.accounts.length === 1,
      encryptedAtRest: Boolean(account.secret) && account.secret.enc === 'os',
      secretNotLeaked: serialized.indexOf(SECRET) === -1,
      secretKeyAbsent: serialized.indexOf('"secret"') === -1,
      decryptsCorrectly: connection.secret === SECRET,
    };

    store.removeAccount(account.id);

    const failed = Object.keys(results).filter((key) => !results[key]);
    console.log(JSON.stringify(results, null, 2));

    if (failed.length > 0) {
      console.error('failed: ' + failed.join(', '));
      setTimeout(() => app.exit(1), 50);
      return;
    }

    console.log('[ok] storage smoke test passed');
    setTimeout(() => app.exit(0), 50);
  } catch (error) {
    console.error(error);
    setTimeout(() => app.exit(1), 50);
  }
});
