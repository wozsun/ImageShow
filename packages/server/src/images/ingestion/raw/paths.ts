import { join, normalize, sep } from "node:path";
import { runtimePaths } from "../../../config/bootstrap-env.ts";
import { ApiError } from "../../../core/api-error.ts";
import type {
  IngestionQueueType,
  IngestionSessionPair
} from "../sessions/model.ts";

const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const rawNamePattern = /^([0-9a-f-]{36})\.raw$/iu;
const partNamePattern = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.part$/iu;

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

function ingestionRawQueueDirectory(queue: IngestionQueueType) {
  return queue === "upload" ? "upload" : "import";
}

export function isIngestionRawSessionName(value: string) {
  return sessionIdPattern.test(value);
}

export function isIngestionRawImageName(value: string) {
  return uuidPattern.test(value);
}

export function parseIngestionRawFileName(name: string) {
  const rawMatch = rawNamePattern.exec(name);
  const partMatch = partNamePattern.exec(name);
  const rawGeneration = rawMatch?.[1] ?? partMatch?.[1];
  const executionToken = partMatch?.[2] ?? null;
  if (
    !rawGeneration
    || !uuidPattern.test(rawGeneration)
    || (executionToken && !uuidPattern.test(executionToken))
  ) return null;
  return {
    rawGeneration: rawGeneration.toLowerCase(),
    executionToken: executionToken?.toLowerCase() ?? null
  };
}

function rawDirectory(
  queue: IngestionQueueType,
  pair: IngestionSessionPair
) {
  const root = normalize(runtimePaths.tempDirectory);
  const path = normalize(join(
    root,
    ingestionRawQueueDirectory(queue),
    assertPathSegment(pair.session_id, sessionIdPattern, false),
    assertPathSegment(pair.image_id, uuidPattern)
  ));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary ingestion path");
  }
  return path;
}

export function ingestionRawPath(
  queue: IngestionQueueType,
  pair: IngestionSessionPair,
  rawGeneration: string
) {
  return join(
    rawDirectory(queue, pair),
    `${assertPathSegment(rawGeneration, uuidPattern)}.raw`
  );
}

export function ingestionRawPartPath(
  queue: IngestionQueueType,
  pair: IngestionSessionPair,
  rawGeneration: string,
  executionToken: string
) {
  return join(
    rawDirectory(queue, pair),
    `${assertPathSegment(rawGeneration, uuidPattern)}.${assertPathSegment(
      executionToken,
      uuidPattern
    )}.part`
  );
}

export function ingestionRawRoot(queue: IngestionQueueType) {
  return join(runtimePaths.tempDirectory, ingestionRawQueueDirectory(queue));
}

export function ingestionRawSessionDirectory(
  queue: IngestionQueueType,
  sessionName: string
) {
  return join(runtimePaths.tempDirectory, ingestionRawQueueDirectory(queue), sessionName);
}
