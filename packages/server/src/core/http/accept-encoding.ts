const encodingOrder = ["br", "zstd", "gzip", "identity"] as const;
export type Encoding = (typeof encodingOrder)[number];
type EncodingGroup = { encodings: Encoding[]; identity: boolean };

export function preferredEncodingGroups(header: string | undefined): EncodingGroup[] {
  const weights = new Map<string, number>();
  for (const part of header?.split(",") ?? []) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const token = name.trim();
    if (token !== "*" && !encodingOrder.some((encoding) => encoding === token)) continue;
    const weight =
      parameters.length === 0
        ? 1
        : parameters.length === 1 &&
            /^\s*q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.test(parameters[0]!)
          ? Number(parameters[0]!.split("=")[1])
          : 0;
    // Conflicting repeated entries must not re-enable an explicitly excluded coding.
    weights.set(token, Math.min(weights.get(token) ?? 1, weight));
  }

  const wildcard = weights.get("*");
  const preferences = encodingOrder
    .map((encoding) => ({
      encoding,
      // Implicit identity is a fallback; an explicit weight participates in ranking.
      weight:
        weights.get(encoding) ??
        (encoding === "identity"
          ? wildcard === 0 ? 0 : -1
          : wildcard ?? 0)
    }))
    .filter(({ weight }) => weight !== 0)
    .sort((left, right) => right.weight - left.weight);

  const groups: EncodingGroup[] = [];
  let previousWeight: number | undefined;
  for (const { encoding, weight } of preferences) {
    if (weight !== previousWeight) {
      groups.push({ encodings: [], identity: false });
      previousWeight = weight;
    }
    const group = groups[groups.length - 1]!;
    if (encoding === "identity") {
      group.identity = true;
      // An available identity representation ends fallback negotiation.
      break;
    }
    group.encodings.push(encoding);
  }
  const last = groups[groups.length - 1];
  if (groups.length > 1 && last?.identity && last.encodings.length === 0) {
    groups.pop();
    groups[groups.length - 1]!.identity = true;
  }
  return groups.length ? groups : [{ encodings: [], identity: false }];
}
