import { isIP, type LookupFunction } from "node:net";

export const externalImageLookupErrorCode = "EXTERNAL_IMAGE_LOOKUP_REJECTED";

type ExternalImageAddress = { address: string; family: number };
type ExternalImageAddressResolver = (
  hostname: string
) => Promise<ExternalImageAddress[]>;

type Ipv4SpecialPurposeRule = readonly [
  base: string,
  prefixLength: number,
  globallyReachable: boolean
];

type Ipv6SpecialPurposeRule = readonly [
  base: string,
  prefixLength: number,
  policy: boolean | "embedded-ipv4"
];

// IANA IPv4 Special-Purpose Address Registry, 2025-10-09. Entries with
// Globally Reachable other than True, including terminated entries, are
// rejected. The most-specific matching prefix wins.
const ipv4SpecialPurposeRules: readonly Ipv4SpecialPurposeRule[] = [
  ["0.0.0.0", 8, false],
  ["0.0.0.0", 32, false],
  ["10.0.0.0", 8, false],
  ["100.64.0.0", 10, false],
  ["127.0.0.0", 8, false],
  ["169.254.0.0", 16, false],
  ["172.16.0.0", 12, false],
  ["192.0.0.0", 24, false],
  ["192.0.0.0", 29, false],
  ["192.0.0.8", 32, false],
  ["192.0.0.9", 32, true],
  ["192.0.0.10", 32, true],
  ["192.0.0.170", 32, false],
  ["192.0.0.171", 32, false],
  ["192.0.2.0", 24, false],
  ["192.31.196.0", 24, true],
  ["192.52.193.0", 24, true],
  ["192.88.99.0", 24, false],
  ["192.88.99.2", 32, false],
  ["192.168.0.0", 16, false],
  ["192.175.48.0", 24, true],
  ["198.18.0.0", 15, false],
  ["198.51.100.0", 24, false],
  ["203.0.113.0", 24, false],
  ["240.0.0.0", 4, false],
  ["255.255.255.255", 32, false]
];

// IANA IPv6 Special-Purpose Address Registry, 2025-10-09. The explicit
// 2000::/3 rule follows the IANA IPv6 Address Space registry: unlisted space
// outside that currently allocatable Global Unicast range is rejected.
// IPv4-mapped and the RFC 6052 well-known /96 prefix are deterministic, so
// their embedded IPv4 address is checked by the IPv4 policy.
const ipv6SpecialPurposeRules: readonly Ipv6SpecialPurposeRule[] = [
  ["::", 96, false],
  ["::", 128, false],
  ["::1", 128, false],
  ["::ffff:0:0", 96, "embedded-ipv4"],
  ["64:ff9b::", 96, "embedded-ipv4"],
  ["64:ff9b:1::", 48, false],
  ["100::", 64, false],
  ["100:0:0:1::", 64, false],
  ["2000::", 3, true],
  ["2001::", 23, false],
  ["2001::", 32, false],
  ["2001:1::1", 128, true],
  ["2001:1::2", 128, true],
  ["2001:1::3", 128, true],
  ["2001:2::", 48, false],
  ["2001:3::", 32, true],
  ["2001:4:112::", 48, true],
  ["2001:10::", 28, false],
  ["2001:20::", 28, true],
  ["2001:30::", 28, true],
  ["2001:db8::", 32, false],
  ["2002::", 16, false],
  ["2620:4f:8000::", 48, true],
  ["3fff::", 20, false],
  ["5f00::", 16, false],
  ["fc00::", 7, false],
  ["fe80::", 10, false],
  ["ff00::", 8, false]
];

function parseIpv4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".");
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InRange(address: number, base: number, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function isGloballyReachableIpv4(address: string) {
  const value = parseIpv4(address);
  if (value === null) return false;

  // Multicast is maintained in a separate IANA registry, not the
  // Special-Purpose Address Registry.
  if (ipv4InRange(value, parseIpv4("224.0.0.0") ?? 0, 4)) return false;

  let matchedPrefixLength = -1;
  let globallyReachable = true;
  for (const [base, prefixLength, ruleGloballyReachable] of ipv4SpecialPurposeRules) {
    const parsedBase = parseIpv4(base);
    if (
      parsedBase !== null &&
      prefixLength > matchedPrefixLength &&
      ipv4InRange(value, parsedBase, prefixLength)
    ) {
      matchedPrefixLength = prefixLength;
      globallyReachable = ruleGloballyReachable;
    }
  }
  return globallyReachable;
}

function parseIpv6(address: string): bigint | null {
  if (address.includes("%") || isIP(address) !== 6) return null;
  const clean = address.toLowerCase();
  const ipv4Tail = clean.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  let value = clean;
  let tailParts: string[] = [];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    const ipv6Prefix = clean.slice(0, clean.length - ipv4Tail.length);
    value = ipv6Prefix.endsWith("::") ? ipv6Prefix : ipv6Prefix.replace(/:$/, "");
    tailParts = [
      ((ipv4 >>> 16) & 0xffff).toString(16),
      (ipv4 & 0xffff).toString(16)
    ];
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - tailParts.length - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
    ...tailParts
  ];
  if (parts.length !== 8) return null;

  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    result = (result << 16n) + BigInt(parseInt(part, 16));
  }
  return result;
}

function ipv6InRange(address: bigint, base: bigint, bits: number) {
  const all = (1n << 128n) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(128 - bits)) & all;
  return (address & mask) === (base & mask);
}

function ipv4FromIpv6(value: bigint) {
  const ipv4 = Number(value & 0xffffffffn);
  return `${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`;
}

function isGloballyReachableIpv6(address: string) {
  const value = parseIpv6(address);
  if (value === null) return false;

  let matchedPrefixLength = -1;
  let policy: Ipv6SpecialPurposeRule[2] = false;
  for (const [base, prefixLength, rulePolicy] of ipv6SpecialPurposeRules) {
    const parsedBase = parseIpv6(base);
    if (
      parsedBase !== null &&
      prefixLength > matchedPrefixLength &&
      ipv6InRange(value, parsedBase, prefixLength)
    ) {
      matchedPrefixLength = prefixLength;
      policy = rulePolicy;
    }
  }

  return policy === "embedded-ipv4"
    ? isGloballyReachableIpv4(ipv4FromIpv6(value))
    : policy;
}

function isGloballyReachableAddress({ address, family }: ExternalImageAddress) {
  const parsedFamily = isIP(address);
  if (parsedFamily !== family) return false;
  if (family === 4) return isGloballyReachableIpv4(address);
  if (family === 6) return isGloballyReachableIpv6(address);
  return false;
}

function externalImageLookupError(message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), {
    code: externalImageLookupErrorCode
  });
}

function assertExternalImageAddresses(addresses: ExternalImageAddress[]) {
  if (!addresses.length || addresses.some((address) => !isGloballyReachableAddress(address))) {
    throw externalImageLookupError("Blocked external image address");
  }
}

export function createExternalImageLookup(
  resolveAddresses: ExternalImageAddressResolver
): LookupFunction {
  return (hostname, options, callback) => {
    Promise.resolve().then(() => resolveAddresses(hostname)).then((addresses) => {
      try {
        assertExternalImageAddresses(addresses);
        const requestedFamily = typeof options.family === "number"
          ? options.family
          : 0;
        const candidates = requestedFamily
          ? addresses.filter(({ family }) => family === requestedFamily)
          : addresses;
        if (!candidates.length) {
          throw externalImageLookupError(
            "No external image address for requested family"
          );
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      } catch (error) {
        callback(error as NodeJS.ErrnoException, "", 0);
      }
    }, (error) => {
      callback(
        externalImageLookupError("External image DNS lookup failed", error),
        "",
        0
      );
    });
  };
}
