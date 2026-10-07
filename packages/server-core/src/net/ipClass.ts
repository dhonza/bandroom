import net from "node:net";

/**
 * Address classification for server-side fetches of user-given URLs (SPEC §25.4, SSRF). Only
 * public unicast addresses may be contacted: loopback, private, CGNAT, link-local, ULA,
 * multicast, documentation, benchmark, reserved and unspecified ranges are blocked, including
 * IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4) and Teredo.
 */

type V4 = readonly [number, number, number, number];

/** [first octets…, prefix length]. */
const BLOCKED_V4: readonly (readonly [V4, number])[] = [
  [[0, 0, 0, 0], 8], // "this network", unspecified
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (cloud metadata)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
];

function inPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 8) {
    const take = Math.min(8, bits - i);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i / 8] ?? 0) & mask) !== ((prefix[i / 8] ?? 0) & mask)) return false;
  }
  return true;
}

function parseV4(ip: string): V4 | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

/** 16 bytes of an IPv6 address (with an optional dotted IPv4 tail), or null. */
export function parseV6(ip: string): number[] | null {
  const addr = ip.split("%")[0] ?? ""; // zone id
  if (!net.isIPv6(addr)) return null;
  let head = addr;
  const tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  const v4 = parseV4(addr.slice(lastColon + 1));
  if (v4) {
    head = `${addr.slice(0, lastColon + 1)}0:0`;
    tail.push(...v4);
  }
  const [left = "", right] = head.split("::");
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const l = groups(left);
  const r = right === undefined ? [] : groups(right);
  const fill = right === undefined ? 0 : 8 - l.length - r.length;
  const words = [...l, ...Array<number>(fill).fill(0), ...r];
  if (words.length !== 8) return null;
  const bytes = words.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function blockedV4(b: V4): boolean {
  return BLOCKED_V4.some(([prefix, bits]) => inPrefix(b, prefix, bits));
}

function blockedV6(b: number[]): boolean {
  const v4At = (at: number): V4 => [b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0];
  // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64): judged by the IPv4 address.
  if (inPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return blockedV4(v4At(12));
  if (inPrefix(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return blockedV4(v4At(12));
  // 2002:a.b.c.d::/48 (6to4).
  if (inPrefix(b, [0x20, 0x02], 16)) return blockedV4(v4At(2));
  // Everything outside global unicast 2000::/3 is blocked (::, ::1, ::/96, fc00::/7, fe80::/10,
  // ff00::/8, 64:ff9b:1::/48, 100::/64 …), and inside it Teredo and documentation.
  if (!inPrefix(b, [0x20], 3)) return true;
  if (inPrefix(b, [0x20, 0x01, 0, 0], 32)) return true; // Teredo
  if (inPrefix(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // documentation
  if (inPrefix(b, [0x3f, 0xff], 20)) return true; // documentation (3fff::/20)
  return false;
}

/** True unless `ip` is a public unicast IPv4/IPv6 address. Unparsable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return blockedV4(v4);
  const v6 = parseV6(ip);
  return v6 ? blockedV6(v6) : true;
}
