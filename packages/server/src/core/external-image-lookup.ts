import { isIP, type LookupFunction } from "node:net";

export const externalImageLookupErrorCode = "EXTERNAL_IMAGE_LOOKUP_REJECTED";

type ExternalImageAddress = { address: string; family: number };
type ExternalImageAddressResolver = (
  hostname: string
) => Promise<ExternalImageAddress[]>;

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InRange(address: number, base: number, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function isBlockedIpv4(address: string) {
  const value = parseIpv4(address);
  if (value === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ].some(([base, bits]) => ipv4InRange(
    value,
    parseIpv4(base as string) ?? 0,
    bits as number
  ));
}

function parseIpv6(address: string): bigint | null {
  const clean = address.toLowerCase().split("%", 1)[0];
  const ipv4Tail = clean.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  let value = clean;
  let tailParts: string[] = [];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    value = clean.slice(0, clean.length - ipv4Tail.length).replace(/:$/, "");
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

function isBlockedIpv6(address: string) {
  const value = parseIpv6(address);
  if (value === null) return true;
  const mapped = parseIpv6("::ffff:0:0");
  if (mapped !== null && ipv6InRange(value, mapped, 96)) {
    const ipv4 = Number(value & 0xffffffffn);
    return isBlockedIpv4(
      `${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`
    );
  }
  return [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32]
  ].some(([base, bits]) => {
    const parsedBase = parseIpv6(base as string);
    return parsedBase !== null && ipv6InRange(value, parsedBase, bits as number);
  });
}

function isBlockedIp(address: string) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function externalImageLookupError(message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), {
    code: externalImageLookupErrorCode
  });
}

function assertExternalImageAddresses(addresses: ExternalImageAddress[]) {
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
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
