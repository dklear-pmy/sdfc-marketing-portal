/* Deep links into the Mailpit sink UI (mail.sdfc.dev, behind IAP — opening
   one may prompt a Google sign-in the first time). Mailpit's SPA routes:
   /search?q=… and /view/<message-id>. */

export const MAILPIT_URL = 'https://mail.sdfc.dev';

export const mailpitSearchUrl = (query: string) =>
  `${MAILPIT_URL}/search?q=${encodeURIComponent(query)}`;

/* Everything ever sent to one sink address — the natural per-run/per-tripwire link. */
export const mailpitInboxUrl = (address: string) => mailpitSearchUrl(`to:"${address}"`);

export const mailpitMessageUrl = (id: string) => `${MAILPIT_URL}/view/${encodeURIComponent(id)}`;
