import { uuidV7Timestamp } from "../../core/uuid.ts";

const stagingImageSuffix = ".image.webp";
const stagingThumbnailSuffix = ".thumb.webp";
const stagingObjectSuffixes = [stagingImageSuffix, stagingThumbnailSuffix] as const;
const uuidPrefixPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.|$)/i;
const v5StagingPrefixPattern = /^([A-Za-z0-9_-]{43})\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\//iu;

export function stagingSessionId(key: string) {
  const v5Match = v5StagingPrefixPattern.exec(key);
  if (v5Match) return v5Match[1] ?? "";
  const suffix = stagingObjectSuffixes.find((candidate) => (
    key.length > candidate.length && key.endsWith(candidate)
  ));
  if (!suffix) return "";
  const base = key.slice(0, -suffix.length);
  const match = uuidPrefixPattern.exec(base);
  return match ? match[0].replace(/\.$/, "") : "";
}

function v5Segment(value: string, pattern: RegExp, lowercase = true) {
  if (!pattern.test(value)) throw new Error("Invalid import staging identity");
  return lowercase ? value.toLowerCase() : value;
}

const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const importStagingKeyPattern = new RegExp(
  `^(${sessionIdPattern.source.slice(1, -1)})/`
    + `(${uuidV7Pattern.source.slice(1, -1)})/`
    + `(${uuidV7Pattern.source.slice(1, -1)})\\.`
    + `(${uuidV7Pattern.source.slice(1, -1)})`
    + `(${stagingImageSuffix.replaceAll(".", "\\.")}|${stagingThumbnailSuffix.replaceAll(".", "\\.")})$`,
  "iu"
);
const localAtomicCandidatePattern = new RegExp(
  "^(.*)\\.candidate-[0-9a-f]{8}-[0-9a-f]{4}"
    + "-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "iu"
);

type ImportStagingKeyIdentity = Readonly<{
  session_id: string;
  image_id: string;
  generation: string;
  execution_token: string;
  kind: "image" | "thumbnail";
  created_at: number;
}>;

function parseImportStagingKey(key: string): ImportStagingKeyIdentity | null {
  const match = importStagingKeyPattern.exec(key);
  if (!match) return null;
  const createdAt = uuidV7Timestamp(match[3] ?? "");
  if (createdAt === null) return null;
  return {
    session_id: match[1] ?? "",
    image_id: (match[2] ?? "").toLowerCase(),
    generation: (match[3] ?? "").toLowerCase(),
    execution_token: (match[4] ?? "").toLowerCase(),
    kind: match[5]?.toLowerCase() === stagingImageSuffix ? "image" : "thumbnail",
    created_at: createdAt
  };
}

export type ImportStagingCleanupKeyIdentity = ImportStagingKeyIdentity & Readonly<{
  base_key: string;
  local_atomic_candidate: boolean;
}>;

/**
 * Recognize the only non-protocol key shape that the local driver's atomic
 * publication can leave after a process crash. Callers must still restrict
 * candidate acceptance to a currently-local physical backend.
 */
export function parseImportStagingCleanupKey(
  key: string
): ImportStagingCleanupKeyIdentity | null {
  const direct = parseImportStagingKey(key);
  if (direct) {
    return {
      ...direct,
      base_key: key,
      local_atomic_candidate: false
    };
  }
  const candidate = localAtomicCandidatePattern.exec(key);
  const baseKey = candidate?.[1] ?? "";
  const identity = baseKey ? parseImportStagingKey(baseKey) : null;
  if (!identity) return null;
  return {
    ...identity,
    base_key: baseKey,
    local_atomic_candidate: true
  };
}

export function importStagingImageKey(input: {
  session_id: string;
  image_id: string;
  generation: string;
  execution_token: string;
}) {
  return [
    v5Segment(input.session_id, sessionIdPattern, false),
    v5Segment(input.image_id, uuidV7Pattern),
    `${v5Segment(input.generation, uuidV7Pattern)}.${v5Segment(
      input.execution_token,
      uuidV7Pattern
    )}${stagingImageSuffix}`
  ].join("/");
}

export function importStagingThumbnailKey(input: {
  session_id: string;
  image_id: string;
  generation: string;
  execution_token: string;
}) {
  return [
    v5Segment(input.session_id, sessionIdPattern, false),
    v5Segment(input.image_id, uuidV7Pattern),
    `${v5Segment(input.generation, uuidV7Pattern)}.${v5Segment(
      input.execution_token,
      uuidV7Pattern
    )}${stagingThumbnailSuffix}`
  ].join("/");
}
