import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { RetrievalError } from "./types.js";

export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;
export type FetchPolicy = {
  /** Trusted process configuration only, never copied from HTTP input. */
  loopbackOrigins?: readonly string[];
  /** Known site-term restrictions can be enforced here in addition to robots. */
  sourceAllowed?: (url: URL) => boolean;
};

export const resolveAddresses: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export function parseHttpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new RetrievalError("INVALID_URL", "Invalid company URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new RetrievalError("INVALID_URL", "Only HTTP(S) URLs without credentials are accepted.");
  }
  url.hash = "";
  return url;
}

export function addressRange(address: string): string {
  if (!isIP(address) || address.includes("%")) return "invalid";
  const parsed = ipaddr.process(address);
  const bytes = parsed.toByteArray();
  // RFC 6052's well-known /96 prefix only: its last 32 bits are IPv4.
  // Never classify translated loopback as local (including fixture policies).
  const nat64Prefix = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
  if (bytes.length === 16 && nat64Prefix.every((byte, index) => bytes[index] === byte)) {
    return ipaddr.fromByteArray(bytes.slice(12)).range() === "unicast" ? "unicast" : "rfc6052";
  }
  const range = parsed.range();
  // Deprecated IPv4-compatible ::/96 is not ordinary public IPv6.
  if (range === "unicast" && bytes.length === 16 && bytes.slice(0, 12).every((byte) => byte === 0)) return "reserved";
  return range;
}

export function localFixturePolicy(origins: readonly string[]): FetchPolicy {
  const normalized = origins.map((origin) => {
    const url = parseHttpUrl(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (hostname !== "localhost" && addressRange(hostname) !== "loopback") {
      throw new RetrievalError("INVALID_POLICY", "Fixture exceptions must name loopback origins.");
    }
    return url.origin;
  });
  return { loopbackOrigins: Object.freeze(normalized) };
}

export async function validateDestination(
  input: string, policy: FetchPolicy = {}, resolver: Resolver = resolveAddresses,
): Promise<{ url: URL; address: Address }> {
  const url = parseHttpUrl(input);
  const local = policy.loopbackOrigins?.includes(url.origin) === true;
  if (policy.sourceAllowed && !policy.sourceAllowed(new URL(url.href))) {
    throw new RetrievalError("SOURCE_POLICY_BLOCKED", "Source policy forbids this destination.");
  }
  if (!local && url.port && !["80", "443"].includes(url.port)) {
    throw new RetrievalError("BLOCKED_PORT", "Production retrieval only permits web ports.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Address[];
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
  } catch { throw new RetrievalError("DNS_FAILED", "Could not resolve the source hostname."); }
  if (!addresses.length || addresses.some((entry) => {
    const range = addressRange(entry.address);
    return local ? range !== "loopback" : range !== "unicast";
  })) {
    throw new RetrievalError("BLOCKED_ADDRESS", "Source resolves to a nonpublic or disallowed address.");
  }
  return { url, address: addresses[0]! };
}
