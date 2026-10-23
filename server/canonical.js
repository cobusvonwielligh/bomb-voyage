// One name in the address bar.
//
// The box answers on several names — the apex, www, the sslip.io name the certificate was first
// issued for, and the bare elastic IP — and every one that is not the canonical name bounces to
// it. Players share links, and three links for the same game is how half the office ends up on a
// URL that stops working.
//
// Its own module so it can be tested without starting a server, and because reflecting a request
// header into a Location is the kind of thing that deserves a test.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Endpoints that must answer on whatever name they are called by: /healthz is polled over
// https://localhost by infra/deploy.sh, /deploy by the self-update webhook.
const NEVER_REDIRECT = new Set(['/healthz', '/deploy']);

/** Hostname only: port stripped, lowercased. Null if it is not a plausible hostname. */
export function requestHost(hostHeader) {
  const raw = String(hostHeader ?? '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return host && /^[a-z0-9.\-[\]:]+$/.test(host) ? host : null;
}

/**
 * Where this request should go instead, or null to serve it here.
 *
 * Never redirects loopback: a 301 on `https://localhost/healthz` would make every deploy look
 * like a failed one. Never redirects when `public_host` is still the local default, so a laptop
 * running `npm start` behaves. Never redirects plain HTTP either — that listener has its own
 * unconditional bounce to HTTPS, and sending someone through two hops is pointless.
 *
 * @param {{host?: string, url: string, want?: string, tls: boolean}} req
 */
export function canonicalTarget({ host, url, want, tls }) {
  if (!tls || !want || LOOPBACK.has(want)) return null;
  if (NEVER_REDIRECT.has(url.split('?')[0])) return null;
  const got = requestHost(host);
  if (!got || got === want || LOOPBACK.has(got)) return null;
  // `url` is the origin-form request target, so it always starts with `/` and Node has already
  // rejected control characters in it. The destination host comes from config, never from the
  // request, so there is nothing of the client's in the authority part of this Location.
  return `https://${want}${url}`;
}
