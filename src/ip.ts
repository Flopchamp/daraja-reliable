export type IpMatcher = (ip: string) => boolean;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4ToInt(s: string): number | null {
  const m = V4.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** `::ffff:196.201.214.200` (how Node reports IPv4 peers on dual-stack sockets) -> `196.201.214.200`. */
function normalise(ip: string): string {
  const s = ip.trim().toLowerCase();
  return s.startsWith('::ffff:') && V4.test(s.slice(7)) ? s.slice(7) : s;
}

/**
 * Build a matcher from exact IPs and IPv4 CIDRs (`196.201.214.0/24`). IPv6 is supported as an
 * exact address only. Throws on a malformed entry so a typo fails at startup, not silently
 * at 3am by rejecting every real callback.
 */
export function buildIpMatcher(entries: readonly string[]): IpMatcher {
  const v4: { base: number; mask: number }[] = [];
  const exact = new Set<string>();

  for (const raw of entries) {
    const entry = normalise(raw);
    const [addr = '', bits, ...extra] = entry.split('/');
    if (extra.length > 0) throw new Error(`invalid trusted IP entry "${raw}"`);

    const n = v4ToInt(addr);
    if (n !== null) {
      const len = bits === undefined ? 32 : Number(bits);
      if (!Number.isInteger(len) || len < 0 || len > 32 || (bits !== undefined && bits.trim() === '')) {
        throw new Error(`invalid CIDR prefix in "${raw}"`);
      }
      const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
      v4.push({ base: (n & mask) >>> 0, mask });
    } else if (addr.includes(':') && bits === undefined) {
      exact.add(addr);
    } else {
      throw new Error(`invalid trusted IP entry "${raw}" (IPv6 CIDR is not supported)`);
    }
  }

  return (ip) => {
    const s = normalise(ip);
    const n = v4ToInt(s);
    if (n !== null) return v4.some((r) => ((n & r.mask) >>> 0) === r.base);
    return exact.has(s);
  };
}
