import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

export const externalImageLookupErrorCode = "EXTERNAL_IMAGE_LOOKUP_REJECTED";

type ExternalImageAddress = { address: string; family: number };
type ExternalImageAddressResolver = (
  hostname: string
) => Promise<ExternalImageAddress[]>;

type Ipv4Address = ReturnType<typeof ipaddr.IPv4.parse>;
type Ipv6Address = ReturnType<typeof ipaddr.IPv6.parse>;

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

const ipv4MulticastBase = ipaddr.IPv4.parse("224.0.0.0");
const parsedIpv4SpecialPurposeRules = ipv4SpecialPurposeRules.map(
  ([base, prefixLength, globallyReachable]) => [
    ipaddr.IPv4.parse(base),
    prefixLength,
    globallyReachable
  ] as const
);
const parsedIpv6SpecialPurposeRules = ipv6SpecialPurposeRules.map(
  ([base, prefixLength, policy]) => [
    ipaddr.IPv6.parse(base),
    prefixLength,
    policy
  ] as const
);

function isGloballyReachableIpv4(address: Ipv4Address) {

  // Multicast is maintained in a separate IANA registry, not the
  // Special-Purpose Address Registry.
  if (address.match(ipv4MulticastBase, 4)) return false;

  let matchedPrefixLength = -1;
  let globallyReachable = true;
  for (const rule of parsedIpv4SpecialPurposeRules) {
    const [base, prefixLength, ruleGloballyReachable] = rule;
    if (
      prefixLength > matchedPrefixLength &&
      address.match(base, prefixLength)
    ) {
      matchedPrefixLength = prefixLength;
      globallyReachable = ruleGloballyReachable;
    }
  }
  return globallyReachable;
}

function isGloballyReachableIpv6(address: Ipv6Address) {
  let matchedPrefixLength = -1;
  let policy: Ipv6SpecialPurposeRule[2] = false;
  for (const rule of parsedIpv6SpecialPurposeRules) {
    const [base, prefixLength, rulePolicy] = rule;
    if (
      prefixLength > matchedPrefixLength &&
      address.match(base, prefixLength)
    ) {
      matchedPrefixLength = prefixLength;
      policy = rulePolicy;
    }
  }

  if (policy !== "embedded-ipv4") return policy;
  const embeddedAddress = ipaddr.fromByteArray(address.toByteArray().slice(-4));
  return embeddedAddress instanceof ipaddr.IPv4 &&
    isGloballyReachableIpv4(embeddedAddress);
}

function isGloballyReachableAddress({ address, family }: ExternalImageAddress) {
  const parsedFamily = isIP(address);
  if (parsedFamily !== family) return false;
  if (family === 4) {
    return ipaddr.IPv4.isValidFourPartDecimal(address) &&
      isGloballyReachableIpv4(ipaddr.IPv4.parse(address));
  }
  if (family === 6) {
    // ipaddr.js canonicalizes bare IPv4-tail IPv6 text to ::ffff:w.x.y.z.
    // Reject that syntax before parsing so the actual ::/96 address cannot
    // inherit the mapped-address policy.
    const isBareIpv4Compatible = address.startsWith("::") &&
      address.lastIndexOf(":") === 1 &&
      address.includes(".");
    return !address.includes("%") &&
      !isBareIpv4Compatible &&
      ipaddr.IPv6.isValid(address) &&
      isGloballyReachableIpv6(ipaddr.IPv6.parse(address));
  }
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
