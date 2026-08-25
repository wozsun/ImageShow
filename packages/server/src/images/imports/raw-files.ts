import { createWriteStream } from "node:fs";
import type { Dir, Dirent } from "node:fs";
import { appConfig } from "@imageshow/shared";
import {
  link,
  mkdir,
  opendir,
  rm,
  rmdir,
  stat
} from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileTypeFromFile } from "file-type";
import sharp, { type Metadata } from "sharp";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { ApiError } from "../../core/api-error.ts";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.ts";
import type {
  ImportQueueType,
  ImportSessionPair
} from "./session-model.ts";
import { importQueueTypes } from "./session-model.ts";

const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedRawExtensions = new Set(["jpg", "png", "webp", "gif", "avif"]);
const activeRawPaths = new Map<string, number>();
const deletingRawPaths = new Map<string, Promise<void>>();
const activeRawDirectories = new Map<string, number>();
const pruningRawDirectories = new Map<string, Promise<void>>();
const scanningRawDirectories = new Map<string, number>();

function rawPathIdentity(path: string) {
  const identity = normalize(resolve(path));
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

async function retainActiveRawPath(identity: string) {
  for (;;) {
    const deleting = deletingRawPaths.get(identity);
    if (deleting) {
      await deleting;
      continue;
    }
    activeRawPaths.set(identity, (activeRawPaths.get(identity) ?? 0) + 1);
    return;
  }
}

function releaseActiveRawPath(identity: string) {
  const count = activeRawPaths.get(identity) ?? 0;
  if (count <= 1) activeRawPaths.delete(identity);
  else activeRawPaths.set(identity, count - 1);
}

async function tryWithInactiveRawPath<T>(
  path: string,
  work: () => Promise<T>
) {
  const identity = rawPathIdentity(path);
  if (activeRawPaths.has(identity) || deletingRawPaths.has(identity)) {
    return null;
  }
  let settle!: () => void;
  const deleting = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  deletingRawPaths.set(identity, deleting);
  try {
    return await work();
  } finally {
    deletingRawPaths.delete(identity);
    settle();
  }
}

function rawLeaseDirectories(paths: readonly string[]) {
  const directories = new Map<string, string>();
  for (const path of paths) {
    const imageDirectory = resolve(dirname(path));
    const sessionDirectory = resolve(dirname(imageDirectory));
    for (const directory of [imageDirectory, sessionDirectory]) {
      directories.set(rawPathIdentity(directory), directory);
    }
  }
  return [...directories.entries()]
    .map(([identity, path]) => ({ identity, path }))
    .toSorted((left, right) => left.identity.localeCompare(right.identity));
}

async function retainActiveRawDirectory(identity: string) {
  for (;;) {
    const pruning = pruningRawDirectories.get(identity);
    if (pruning) {
      await pruning;
      continue;
    }
    activeRawDirectories.set(
      identity,
      (activeRawDirectories.get(identity) ?? 0) + 1
    );
    return;
  }
}

function releaseActiveRawDirectory(identity: string) {
  const count = activeRawDirectories.get(identity) ?? 0;
  if (count <= 1) activeRawDirectories.delete(identity);
  else activeRawDirectories.set(identity, count - 1);
}

function retainScanningRawDirectory(identity: string) {
  scanningRawDirectories.set(
    identity,
    (scanningRawDirectories.get(identity) ?? 0) + 1
  );
}

function releaseScanningRawDirectory(identity: string) {
  const count = scanningRawDirectories.get(identity) ?? 0;
  if (count <= 1) scanningRawDirectories.delete(identity);
  else scanningRawDirectories.set(identity, count - 1);
}

function ignorableEmptyDirectoryError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT"
    || code === "ENOTEMPTY"
    || code === "EEXIST"
    || code === "EBUSY"
    || code === "EPERM";
}

async function pruneImportRawDirectory(path: string) {
  const identity = rawPathIdentity(path);
  const pending = pruningRawDirectories.get(identity);
  if (pending) return pending;
  if (
    activeRawDirectories.has(identity)
    || scanningRawDirectories.has(identity)
  ) return;
  let settle!: () => void;
  const pruning = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  pruningRawDirectories.set(identity, pruning);
  try {
    await rmdir(path);
  } catch (error) {
    if (!ignorableEmptyDirectoryError(error)) throw error;
  } finally {
    pruningRawDirectories.delete(identity);
    settle();
  }
}

async function pruneImportRawParents(path: string) {
  const imageDirectory = resolve(dirname(path));
  await pruneImportRawDirectory(imageDirectory);
  await pruneImportRawDirectory(resolve(dirname(imageDirectory)));
}

export async function withActiveImportRawPaths<T>(
  paths: readonly string[],
  work: () => Promise<T>
) {
  const directories = rawLeaseDirectories(paths);
  for (const directory of directories) {
    await retainActiveRawDirectory(directory.identity);
  }
  const identities = [...new Set(paths.map(rawPathIdentity))].toSorted();
  for (const identity of identities) await retainActiveRawPath(identity);
  try {
    return await work();
  } finally {
    for (const identity of identities) releaseActiveRawPath(identity);
    for (const directory of directories) {
      releaseActiveRawDirectory(directory.identity);
    }
    for (const directory of directories.toSorted((left, right) => (
      right.path.length - left.path.length
    ))) {
      await pruneImportRawDirectory(directory.path).catch(() => undefined);
    }
  }
}

function assertPathSegment(
  value: string,
  pattern: RegExp,
  lowercase = true
) {
  if (!pattern.test(value)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary import identity");
  }
  return lowercase ? value.toLowerCase() : value;
}

function queueDirectory(queue: ImportQueueType) {
  return queue === "upload" ? "upload" : "import";
}

function rawDirectory(
  queue: ImportQueueType,
  pair: ImportSessionPair
) {
  const root = normalize(runtimePaths.tempDirectory);
  const path = normalize(join(
    root,
    queueDirectory(queue),
    assertPathSegment(pair.session_id, sessionIdPattern, false),
    assertPathSegment(pair.image_id, uuidPattern)
  ));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe temporary import path");
  }
  return path;
}

export function importRawPath(
  queue: ImportQueueType,
  pair: ImportSessionPair,
  rawGeneration: string
) {
  return join(
    rawDirectory(queue, pair),
    `${assertPathSegment(rawGeneration, uuidPattern)}.raw`
  );
}

export function importRawPartPath(
  queue: ImportQueueType,
  pair: ImportSessionPair,
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

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function openDirectoryIfExists(path: string) {
  try {
    return await opendir(path, { bufferSize: 64 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function publishImportRawPart(
  partPath: string,
  rawPath: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  try {
    await link(partPath, rawPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await statIfExists(rawPath);
    if (!existing?.isFile()) throw error;
  }
  // Publication already succeeded; a leftover part is an orphan-cleanup
  // concern and must not make the caller abandon the referenced raw file.
  await rm(partPath, { force: true }).catch(() => undefined);
  return rawPath;
}

async function validateRawImagePart(path: string, maxLongEdge: number) {
  const detected = await fileTypeFromFile(path);
  if (!detected || !allowedRawExtensions.has(detected.ext)) {
    throw new ApiError(400, "unsupported_image_body", "上传正文不是支持的图片格式");
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(path, { animated: false }).metadata();
  } catch {
    throw new ApiError(400, "invalid_image_body", "上传图片无法解码");
  }
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!width || !height) {
    throw new ApiError(400, "invalid_image_dimensions", "无法读取上传图片尺寸");
  }
  if (Math.max(width, height) > maxLongEdge) {
    throw new ApiError(400, "upload_dimensions_exceeded", "图片长边超过限制", {
      limit: maxLongEdge,
      width,
      height
    });
  }
}

export async function receiveUploadRaw(
  input: Readonly<{
    pair: ImportSessionPair;
    raw_generation: string;
    execution_token: string;
    body: ReadableStream<Uint8Array>;
    expected_size: number;
    maximum_size: number;
    max_long_edge: number;
    signal?: AbortSignal;
    heartbeat?: () => Promise<void>;
  }>
) {
  const rawPath = importRawPath("upload", input.pair, input.raw_generation);
  const partPath = importRawPartPath(
    "upload",
    input.pair,
    input.raw_generation,
    input.execution_token
  );
  await mkdir(dirname(rawPath), { recursive: true });
  let total = 0;
  const heartbeatController = new AbortController();
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, heartbeatController.signal])
    : heartbeatController.signal;
  let stopped = false;
  let pendingHeartbeat = Promise.resolve();
  const queueHeartbeat = () => {
    pendingHeartbeat = pendingHeartbeat.then(async () => {
      if (stopped || combinedSignal.aborted || !input.heartbeat) return;
      try {
        await input.heartbeat();
      } catch (error) {
        if (!stopped && !combinedSignal.aborted) {
          heartbeatController.abort(error);
        }
      }
    });
  };
  const heartbeatTimer = input.heartbeat
    ? setInterval(
      queueHeartbeat,
      appConfig.importRuntime.workerHeartbeatSeconds * 1000
    )
    : null;
  heartbeatTimer?.unref();
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > input.maximum_size || total > input.expected_size) {
        throw new ApiError(400, "upload_too_large", "图片大小超过限制", {
          limit: Math.min(input.maximum_size, input.expected_size)
        });
      }
      controller.enqueue(chunk);
    }
  });
  try {
    await pipeline(
      nodeReadableFromWeb(input.body.pipeThrough(limiter)),
      createWriteStream(partPath),
      { signal: combinedSignal }
    );
    if (total !== input.expected_size) {
      throw new ApiError(400, "size_mismatch", "Upload size mismatch", {
        expected: input.expected_size,
        actual: total
      });
    }
    await validateRawImagePart(partPath, input.max_long_edge);
    combinedSignal.throwIfAborted();
    await publishImportRawPart(partPath, rawPath, combinedSignal);
    return { rawPath, rawSize: total };
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined);
    if (heartbeatController.signal.aborted) {
      throw heartbeatController.signal.reason;
    }
    throw error;
  } finally {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await pendingHeartbeat;
  }
}

async function removeInactiveImportRawPath(path: string) {
  const identity = rawPathIdentity(path);
  const removed = await tryWithInactiveRawPath(
    path,
    async () => {
      if (activeRawPaths.has(identity)) return false;
      await rm(path, { force: true });
      return true;
    }
  );
  if (removed) await pruneImportRawParents(path);
}

export async function removeImportRaw(
  queue: ImportQueueType,
  pair: ImportSessionPair,
  rawGeneration: string
) {
  await removeInactiveImportRawPath(importRawPath(
    queue,
    pair,
    rawGeneration
  ));
}

/** Delete an exact raw generation while the caller owns its active-path lease. */
export async function removeOwnedImportRaw(
  queue: ImportQueueType,
  pair: ImportSessionPair,
  rawGeneration: string
) {
  const path = importRawPath(queue, pair, rawGeneration);
  await rm(path, { force: true });
  await pruneImportRawParents(path);
}

export async function removeImportRawPart(
  queue: ImportQueueType,
  pair: ImportSessionPair,
  rawGeneration: string,
  executionToken: string
) {
  const path = importRawPartPath(
    queue,
    pair,
    rawGeneration,
    executionToken
  );
  // Part-file callers execute inside withActiveImportRawPaths and therefore
  // already own the exclusion lease that makes this exact unlink safe.
  await rm(path, { force: true });
  await pruneImportRawParents(path);
}

type ImportRawFileEntry = Readonly<{
  path: string;
  modifiedAt: number;
  queue: ImportQueueType;
  pair: ImportSessionPair;
  raw_generation: string;
  execution_token: string | null;
  kind: "raw" | "part";
}>;

const rawNamePattern = /^([0-9a-f-]{36})\.raw$/iu;
const partNamePattern = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.part$/iu;

type ImportRawScanBudget = {
  remaining: number;
  complete: boolean;
};

async function importRawFileEntry(
  queue: ImportQueueType,
  sessionName: string,
  imageName: string,
  imagePath: string,
  file: Dirent,
  signal?: AbortSignal
): Promise<ImportRawFileEntry | null> {
  if (!file.isFile()) return null;
  const rawMatch = rawNamePattern.exec(file.name);
  const partMatch = partNamePattern.exec(file.name);
  const rawGeneration = rawMatch?.[1] ?? partMatch?.[1];
  const executionToken = partMatch?.[2] ?? null;
  if (
    !rawGeneration
    || !uuidPattern.test(rawGeneration)
    || (executionToken && !uuidPattern.test(executionToken))
  ) return null;
  const path = join(imagePath, file.name);
  const info = await statIfExists(path);
  signal?.throwIfAborted();
  if (!info?.isFile()) return null;
  return {
    path,
    modifiedAt: info.mtimeMs,
    queue,
    pair: {
      session_id: sessionName,
      image_id: imageName.toLowerCase()
    },
    raw_generation: rawGeneration.toLowerCase(),
    execution_token: executionToken?.toLowerCase() ?? null,
    kind: executionToken ? "part" : "raw"
  };
}

async function* directoryEntries(
  path: string,
  budget: ImportRawScanBudget,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const directory = await openDirectoryIfExists(path);
  if (!directory) return;
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (budget.remaining <= 0) {
      budget.complete = false;
      return;
    }
    budget.remaining -= 1;
    yield entry;
  }
}

async function* listImportRawFiles(
  queue: ImportQueueType,
  budget: ImportRawScanBudget,
  signal?: AbortSignal,
  pruneEmptyDirectories = false
) {
  const root = join(runtimePaths.tempDirectory, queueDirectory(queue));
  for await (const session of directoryEntries(root, budget, signal)) {
    if (!session.isDirectory() || !sessionIdPattern.test(session.name)) continue;
    const sessionPath = join(root, session.name);
    for await (const image of directoryEntries(sessionPath, budget, signal)) {
      if (!image.isDirectory() || !uuidPattern.test(image.name)) continue;
      const imagePath = join(sessionPath, image.name);
      for await (const file of directoryEntries(imagePath, budget, signal)) {
        const entry = await importRawFileEntry(
          queue,
          session.name,
          image.name,
          imagePath,
          file,
          signal
        );
        if (entry) yield entry;
      }
      if (pruneEmptyDirectories) {
        await pruneImportRawDirectory(imagePath);
      }
    }
    if (pruneEmptyDirectories) {
      await pruneImportRawDirectory(sessionPath);
    }
  }
}

type RawCleanupOpenDirectory = Readonly<{
  path: string;
  identity: string;
  directory: Dir;
}>;

type RawCleanupImageCursor = RawCleanupOpenDirectory & Readonly<{
  name: string;
}> & {
  pendingFile: Dirent | null;
};

type RawCleanupSessionCursor = RawCleanupOpenDirectory & {
  queue: ImportQueueType;
  name: string;
  image: RawCleanupImageCursor | null;
  pendingImage: Dirent | null;
};

const rawCleanupCursor: {
  queueIndex: number;
  root: Dir | null;
  pendingSession: Dirent | null;
  session: RawCleanupSessionCursor | null;
  passSplit: boolean;
} = {
  queueIndex: 0,
  root: null,
  pendingSession: null,
  session: null,
  passSplit: false
};

async function openTrackedRawCleanupDirectory(
  path: string,
  signal?: AbortSignal
): Promise<RawCleanupOpenDirectory | null> {
  const identity = rawPathIdentity(path);
  for (;;) {
    signal?.throwIfAborted();
    const pruning = pruningRawDirectories.get(identity);
    if (pruning) {
      await pruning;
      continue;
    }
    // Registration is synchronous with the pruning-map check. Whole-directory
    // removal therefore either wins first or observes this long-lived scan
    // handle and leaves the directory for the cursor to finish.
    retainScanningRawDirectory(identity);
    let directory: Dir | null = null;
    try {
      directory = await openDirectoryIfExists(path);
      signal?.throwIfAborted();
      if (!directory) {
        releaseScanningRawDirectory(identity);
        return null;
      }
      return { path, identity, directory };
    } catch (error) {
      await directory?.close().catch(() => undefined);
      releaseScanningRawDirectory(identity);
      throw error;
    }
  }
}

async function closeTrackedRawCleanupDirectory(
  state: RawCleanupOpenDirectory | null
) {
  if (!state) return;
  await state.directory.close().catch(() => undefined);
  releaseScanningRawDirectory(state.identity);
}

async function closeRawCleanupImage() {
  const image = rawCleanupCursor.session?.image ?? null;
  if (rawCleanupCursor.session) rawCleanupCursor.session.image = null;
  await closeTrackedRawCleanupDirectory(image);
}

async function closeRawCleanupSession() {
  const session = rawCleanupCursor.session;
  rawCleanupCursor.session = null;
  await closeTrackedRawCleanupDirectory(session);
}

async function closeRawCleanupRoot() {
  const root = rawCleanupCursor.root;
  rawCleanupCursor.root = null;
  rawCleanupCursor.pendingSession = null;
  await root?.close().catch(() => undefined);
}

function acknowledgeRawCleanupFile() {
  const image = rawCleanupCursor.session?.image;
  if (image) image.pendingFile = null;
}

export async function closeImportRawCleanupCursor() {
  await closeRawCleanupImage();
  await closeRawCleanupSession();
  await closeRawCleanupRoot();
  rawCleanupCursor.queueIndex = 0;
  rawCleanupCursor.passSplit = false;
}

type RawCleanupStep =
  | Readonly<{ kind: "file"; entry: ImportRawFileEntry }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "complete"; complete: boolean }>;

async function nextRawCleanupFile(
  budget: ImportRawScanBudget,
  signal?: AbortSignal
): Promise<RawCleanupStep> {
  for (;;) {
    signal?.throwIfAborted();
    if (budget.remaining <= 0) {
      rawCleanupCursor.passSplit = true;
      return { kind: "paused" };
    }
    const queue = importQueueTypes[rawCleanupCursor.queueIndex];
    if (!queue) {
      const complete = !rawCleanupCursor.passSplit;
      rawCleanupCursor.queueIndex = 0;
      rawCleanupCursor.passSplit = false;
      return { kind: "complete", complete };
    }
    if (!rawCleanupCursor.root) {
      rawCleanupCursor.root = await openDirectoryIfExists(join(
        runtimePaths.tempDirectory,
        queueDirectory(queue)
      ));
      signal?.throwIfAborted();
      if (!rawCleanupCursor.root) {
        rawCleanupCursor.queueIndex += 1;
        continue;
      }
    }

    const currentSession = rawCleanupCursor.session;
    if (!currentSession) {
      const entry = rawCleanupCursor.pendingSession
        ?? await rawCleanupCursor.root.read();
      rawCleanupCursor.pendingSession = entry;
      signal?.throwIfAborted();
      if (!entry) {
        await closeRawCleanupRoot();
        rawCleanupCursor.queueIndex += 1;
        continue;
      }
      budget.remaining -= 1;
      if (!entry.isDirectory() || !sessionIdPattern.test(entry.name)) {
        rawCleanupCursor.pendingSession = null;
        continue;
      }
      const path = join(
        runtimePaths.tempDirectory,
        queueDirectory(queue),
        entry.name
      );
      const opened = await openTrackedRawCleanupDirectory(path, signal);
      rawCleanupCursor.pendingSession = null;
      if (opened) {
        rawCleanupCursor.session = {
          ...opened,
          queue,
          name: entry.name,
          image: null,
          pendingImage: null
        };
      }
      continue;
    }

    const currentImage = currentSession.image;
    if (!currentImage) {
      const entry = currentSession.pendingImage
        ?? await currentSession.directory.read();
      currentSession.pendingImage = entry;
      signal?.throwIfAborted();
      if (!entry) {
        const path = currentSession.path;
        await closeRawCleanupSession();
        await pruneImportRawDirectory(path);
        continue;
      }
      budget.remaining -= 1;
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
        currentSession.pendingImage = null;
        continue;
      }
      const path = join(currentSession.path, entry.name);
      const opened = await openTrackedRawCleanupDirectory(path, signal);
      currentSession.pendingImage = null;
      if (opened) {
        currentSession.image = {
          ...opened,
          name: entry.name,
          pendingFile: null
        };
      }
      continue;
    }

    const file = currentImage.pendingFile
      ?? await currentImage.directory.read();
    currentImage.pendingFile = file;
    signal?.throwIfAborted();
    if (!file) {
      const path = currentImage.path;
      await closeRawCleanupImage();
      await pruneImportRawDirectory(path);
      continue;
    }
    budget.remaining -= 1;
    const entry = await importRawFileEntry(
      currentSession.queue,
      currentSession.name,
      currentImage.name,
      currentImage.path,
      file,
      signal
    );
    if (entry) return { kind: "file", entry };
    currentImage.pendingFile = null;
  }
}

async function removeInactiveImportRawEntry(
  entry: ImportRawFileEntry,
  input: Readonly<{
    keep: ReadonlySet<string>;
    rawCutoff: number;
    partCutoff: number;
    signal?: AbortSignal;
  }>
) {
  const identity = rawPathIdentity(entry.path);
  if (input.keep.has(identity) || activeRawPaths.has(identity)) return false;
  const cutoff = entry.kind === "part" ? input.partCutoff : input.rawCutoff;
  if (entry.modifiedAt >= cutoff) return false;
  const removed = await tryWithInactiveRawPath(
    entry.path,
    async () => {
      input.signal?.throwIfAborted();
      if (input.keep.has(identity) || activeRawPaths.has(identity)) return false;
      const current = await statIfExists(entry.path);
      input.signal?.throwIfAborted();
      if (!current?.isFile() || current.mtimeMs >= cutoff) return false;
      if (activeRawPaths.has(identity)) return false;
      await rm(entry.path, { force: true });
      return true;
    }
  );
  return removed === true;
}

export async function cleanupImportRawOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  rawCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
}>) {
  const budget: ImportRawScanBudget = {
    remaining: appConfig.importRuntime.orphanCleanupMaxRawEntriesPerCycle,
    complete: true
  };
  const keep = new Set([...input.keep].map(rawPathIdentity));
  let removed = 0;
  try {
    for (;;) {
      const next = await nextRawCleanupFile(budget, input.signal);
      if (next.kind === "complete") {
        return { removed, complete: next.complete };
      }
      if (next.kind === "paused") break;
      if (await removeInactiveImportRawEntry(next.entry, { ...input, keep })) {
        removed += 1;
      }
      acknowledgeRawCleanupFile();
    }
  } catch (error) {
    if (input.stopSignal?.aborted) {
      await closeImportRawCleanupCursor();
      input.stopSignal.throwIfAborted();
    }
    if (input.signal?.aborted) {
      // A cycle timeout is a time slice, not a new pass. Keep the bounded
      // three-handle DFS cursor so slow directory prefixes cannot starve the
      // tail forever. Worker stop closes the cursor explicitly above and in
      // ImportOrphanCleanupWorker.stop().
      return { removed, complete: false };
    }
    await closeImportRawCleanupCursor();
    throw error;
  }
  return { removed, complete: false };
}

export async function inspectImportRawOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  rawCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
}>) {
  const budget: ImportRawScanBudget = {
    remaining: appConfig.importRuntime.orphanCleanupMaxRawEntriesPerCycle,
    complete: true
  };
  const keep = new Set([...input.keep].map(rawPathIdentity));
  const summaries = {
    raw: { count: 0, oldest_modified_at: null as number | null },
    part: { count: 0, oldest_modified_at: null as number | null }
  };
  for (const queue of importQueueTypes) {
    for await (const entry of listImportRawFiles(queue, budget, input.signal)) {
      input.signal?.throwIfAborted();
      const identity = rawPathIdentity(entry.path);
      if (keep.has(identity) || activeRawPaths.has(identity)) continue;
      const cutoff = entry.kind === "part" ? input.partCutoff : input.rawCutoff;
      if (entry.modifiedAt >= cutoff) continue;
      const summary = summaries[entry.kind];
      summary.count += 1;
      summary.oldest_modified_at = summary.oldest_modified_at === null
        ? entry.modifiedAt
        : Math.min(summary.oldest_modified_at, entry.modifiedAt);
    }
  }
  return { ...summaries, complete: budget.complete };
}
