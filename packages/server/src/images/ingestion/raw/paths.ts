import { join, normalize, sep } from "node:path";
import { runtimePaths } from "../../../config/bootstrap-env.ts";
import { ApiError } from "../../../core/api-error.ts";
import type { IngestionSessionPair } from "../sessions/model.ts";

const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const rawNamePattern = /^([0-9a-f-]{36})\.raw$/iu;
const partNamePattern = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.part$/iu;
const preparedNamePattern = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.(image|thumb)\.webp(\.part)?$/iu;

function assertPathSegment(
  value: string,
  pattern: RegExp,
  lowercase = true
) {
  if (!pattern.test(value)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary ingestion identity");
  }
  return lowercase ? value.toLowerCase() : value;
}

export function isIngestionTempSessionName(value: string) {
  return sessionIdPattern.test(value);
}

export function isIngestionTempImageName(value: string) {
  return uuidPattern.test(value);
}

export function parseIngestionTempFileName(name: string) {
  const rawMatch = rawNamePattern.exec(name);
  const partMatch = partNamePattern.exec(name);
  const preparedMatch = preparedNamePattern.exec(name);
  const generation = rawMatch?.[1] ?? partMatch?.[1] ?? preparedMatch?.[1];
  const executionToken = partMatch?.[2] ?? preparedMatch?.[2] ?? null;
  if (
    !generation
    || !uuidPattern.test(generation)
    || (executionToken && !uuidPattern.test(executionToken))
  ) return null;
  return {
    kind: (partMatch || preparedMatch?.[4] ? "part" : preparedMatch ? "prepared" : "raw") as "part" | "prepared" | "raw"
  };
}

function rawDirectory(
  pair: IngestionSessionPair
) {
  const root = normalize(runtimePaths.tempDirectory);
  const path = normalize(join(
    root,
    assertPathSegment(pair.session_id, sessionIdPattern, false),
    assertPathSegment(pair.image_id, uuidPattern)
  ));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary ingestion path");
  }
  return path;
}

export function ingestionRawPath(
  pair: IngestionSessionPair,
  rawGeneration: string
) {
  return join(
    rawDirectory(pair),
    `${assertPathSegment(rawGeneration, uuidPattern)}.raw`
  );
}

export function ingestionRawPartPath(
  pair: IngestionSessionPair,
  rawGeneration: string,
  executionToken: string
) {
  return join(
    rawDirectory(pair),
    `${assertPathSegment(rawGeneration, uuidPattern)}.${assertPathSegment(
      executionToken,
      uuidPattern
    )}.part`
  );
}

export function ingestionTempRoot() {
  return runtimePaths.tempDirectory;
}

export function ingestionTempSessionDirectory(
  sessionName: string
) {
  return join(runtimePaths.tempDirectory, assertPathSegment(sessionName, sessionIdPattern, false));
}

export function ingestionPreparedFile(input: IngestionSessionPair & {
  generation: string;
  execution_token: string;
}, kind: "image" | "thumb") {
  return [
    assertPathSegment(input.session_id, sessionIdPattern, false),
    assertPathSegment(input.image_id, uuidPattern),
    `${assertPathSegment(input.generation, uuidPattern)}.${assertPathSegment(input.execution_token, uuidPattern)}.${kind}.webp`
  ].join("/");
}

/** Resolve a canonical prepared-file reference within this application's temp root. */
export function ingestionPreparedPath(file: string) {
  const [session, image, name, extra] = file.split("/");
  if (!session || !image || !name || extra !== undefined || !preparedNamePattern.test(name)) {
    throw new ApiError(400, "unsafe_path", "Unsafe prepared ingestion path");
  }
  const parsed = parseIngestionTempFileName(name);
  if (!parsed || parsed.kind !== "prepared") {
    throw new ApiError(400, "unsafe_path", "Invalid prepared ingestion identity");
  }
  return join(rawDirectory({ session_id: session, image_id: image }), name);
}
