/**
 * SSRF protection.
 *
 * The export server fetches a URL supplied by whoever is using it. Left
 * unguarded that is a request forwarder: someone can point it at
 * `http://169.254.169.254/` and read cloud instance credentials, or at
 * `http://localhost:6379` to reach services bound to the loopback interface.
 *
 * The guard resolves the hostname and rejects anything in a private, loopback,
 * link-local or reserved range. Resolution matters — checking the literal
 * hostname would miss a public DNS name deliberately pointed at 127.0.0.1.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to fetch this URL: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

/** Parse an IPv4 dotted quad into its four octets, or null. */
function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** True for addresses that must never be reachable from a user-supplied URL. */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Octets(address);

  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (isIP(address) === 6) {
    const v6 = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    if (v6.startsWith('fe80')) return true; // link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local
    // IPv4-mapped (::ffff:127.0.0.1) must be checked as IPv4.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  return false;
}

/**
 * Validate a user-supplied site URL.
 *
 * @throws BlockedUrlError when the URL is malformed, uses a non-HTTP scheme, or
 *         resolves to an address that must not be reachable.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('it is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`the "${url.protocol}" scheme is not supported`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (/^localhost$/i.test(hostname) || hostname.endsWith('.localhost')) {
    throw new BlockedUrlError('it points at localhost');
  }

  // A literal IP needs no resolution; a name does.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedUrlError('it points at a private or reserved address');
    }
    return url;
  }

  let resolved: string;
  try {
    resolved = (await lookup(hostname)).address;
  } catch {
    throw new BlockedUrlError('its hostname could not be resolved');
  }

  if (isPrivateAddress(resolved)) {
    throw new BlockedUrlError(
      `it resolves to ${resolved}, which is a private or reserved address`,
    );
  }

  return url;
}
