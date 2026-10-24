'use strict';

/**
 * Mmail · mail checking
 * ---------------------------------------------------------------------------
 * One account check works like this:
 *   1. The first run only stores the current highest UID (no alerts for existing mail).
 *   2. Later runs fetch messages with a UID above the stored one, at most 3 for the notification.
 *   3. Return the unread count for the UI.
 */

const { ImapClient, parseHeaders, toPublicError } = require('./imap');

const MAX_NOTIFY = 3;

/**
 * @param {{email:string, secret:string, host:string, port:number, secure:boolean, lastUid?:number}} config
 */
async function checkMailbox(config) {
  const lastUid = Number(config.lastUid) || 0;
  const client = new ImapClient(config);

  try {
    await client.connect();
    await client.login(config.email, config.secret);
    await client.identify('Mmail');

    const box = await client.select('INBOX');
    const unseen = await client.unseen();

    /* Highest UID currently on the server (uidNext - 1) */
    const latest = Math.max(0, (box.uidNext || 1) - 1);

    if (!lastUid) {
      return {
        ok: true,
        initial: true,
        unread: unseen.length,
        newUid: latest,
        newCount: 0,
        messages: [],
      };
    }

    const messages = [];
    let newUid = lastUid;

    if (latest > lastUid) {
      const found = await client.search('UID ' + (lastUid + 1) + ':*');
      const fresh = found.filter((uid) => uid > lastUid).sort((a, b) => a - b);

      if (fresh.length > 0) {
        const picked = fresh.slice(-MAX_NOTIFY);
        const items = await client.fetchHeaders(picked);
        items
          .sort((a, b) => a.uid - b.uid)
          .forEach((item) => {
            const headers = parseHeaders(item.raw);
            messages.push({ uid: item.uid, subject: headers.subject, from: headers.from });
          });
        newUid = fresh[fresh.length - 1];
      } else {
        newUid = latest;
      }
    }

    return {
      ok: true,
      initial: false,
      unread: unseen.length,
      newUid: Math.max(newUid, lastUid),
      newCount: messages.length,
      messages: messages,
    };
  } catch (err) {
    return { ok: false, error: toPublicError(err), newUid: lastUid, newCount: 0, messages: [] };
  } finally {
    await client.logout();
    client.destroy();
  }
}

module.exports = { checkMailbox, MAX_NOTIFY };
