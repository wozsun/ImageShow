import type { Dir, Dirent } from "node:fs";
import { opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appConfig } from "@imageshow/shared";
import {
  ingestionQueueTypes,
  type IngestionQueueType,
  type IngestionSessionPair
} from "../sessions/model.ts";
import { statIngestionRawIfExists } from "./files.ts";
import {
  closeIngestionRawScanDirectory,
  ingestionRawPathIsActive,
  openIngestionRawScanDirectory,
  pruneIngestionRawDirectory,
  rawPathIdentity,
  tryWithInactiveIngestionRawPath,
  type IngestionRawScanDirectory
} from "./lease-registry.ts";
import {
  ingestionRawRoot,
  ingestionRawSessionDirectory,
  isIngestionRawImageName,
  isIngestionRawSessionName,
  parseIngestionRawFileName
} from "./paths.ts";

async function openDirectoryIfExists(path: string) {
  try {
    return await opendir(path, { bufferSize: 64 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type IngestionRawFileEntry = Readonly<{
  path: string;
  modifiedAt: number;
  queue: IngestionQueueType;
  pair: IngestionSessionPair;
  raw_generation: string;
  execution_token: string | null;
  kind: "raw" | "part";
}>;

type IngestionRawScanBudget = {
  remaining: number;
  complete: boolean;
};

async function ingestionRawFileEntry(
  queue: IngestionQueueType,
  sessionName: string,
  imageName: string,
  imagePath: string,
  file: Dirent,
  signal?: AbortSignal
): Promise<IngestionRawFileEntry | null> {
  if (!file.isFile()) return null;
  const parsedName = parseIngestionRawFileName(file.name);
  if (!parsedName) return null;
  const path = join(imagePath, file.name);
  const info = await statIngestionRawIfExists(path);
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
    raw_generation: parsedName.rawGeneration,
    execution_token: parsedName.executionToken,
    kind: parsedName.executionToken ? "part" : "raw"
  };
}

async function* directoryEntries(
  path: string,
  budget: IngestionRawScanBudget,
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

async function* listIngestionRawFiles(
  queue: IngestionQueueType,
  budget: IngestionRawScanBudget,
  signal?: AbortSignal,
  pruneEmptyDirectories = false
) {
  const root = ingestionRawRoot(queue);
  for await (const session of directoryEntries(root, budget, signal)) {
    if (!session.isDirectory() || !isIngestionRawSessionName(session.name)) {
      continue;
    }
    const sessionPath = join(root, session.name);
    for await (const image of directoryEntries(sessionPath, budget, signal)) {
      if (!image.isDirectory() || !isIngestionRawImageName(image.name)) continue;
      const imagePath = join(sessionPath, image.name);
      for await (const file of directoryEntries(imagePath, budget, signal)) {
        const entry = await ingestionRawFileEntry(
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
        await pruneIngestionRawDirectory(imagePath);
      }
    }
    if (pruneEmptyDirectories) {
      await pruneIngestionRawDirectory(sessionPath);
    }
  }
}

type RawCleanupOpenDirectory = IngestionRawScanDirectory;

type RawCleanupImageCursor = RawCleanupOpenDirectory & Readonly<{
  name: string;
}> & {
  pendingFile: Dirent | null;
};

type RawCleanupSessionCursor = RawCleanupOpenDirectory & {
  queue: IngestionQueueType;
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

async function closeRawCleanupImage() {
  const image = rawCleanupCursor.session?.image ?? null;
  if (rawCleanupCursor.session) rawCleanupCursor.session.image = null;
  await closeIngestionRawScanDirectory(image);
}

async function closeRawCleanupSession() {
  const session = rawCleanupCursor.session;
  rawCleanupCursor.session = null;
  await closeIngestionRawScanDirectory(session);
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

export async function closeIngestionRawCleanupCursor() {
  await closeRawCleanupImage();
  await closeRawCleanupSession();
  await closeRawCleanupRoot();
  rawCleanupCursor.queueIndex = 0;
  rawCleanupCursor.passSplit = false;
}

type RawCleanupStep =
  | Readonly<{ kind: "file"; entry: IngestionRawFileEntry }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "complete"; complete: boolean }>;

async function nextRawCleanupFile(
  budget: IngestionRawScanBudget,
  signal?: AbortSignal
): Promise<RawCleanupStep> {
  for (;;) {
    signal?.throwIfAborted();
    if (budget.remaining <= 0) {
      rawCleanupCursor.passSplit = true;
      return { kind: "paused" };
    }
    const queue = ingestionQueueTypes[rawCleanupCursor.queueIndex];
    if (!queue) {
      const complete = !rawCleanupCursor.passSplit;
      rawCleanupCursor.queueIndex = 0;
      rawCleanupCursor.passSplit = false;
      return { kind: "complete", complete };
    }
    if (!rawCleanupCursor.root) {
      rawCleanupCursor.root = await openDirectoryIfExists(ingestionRawRoot(queue));
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
      if (!entry.isDirectory() || !isIngestionRawSessionName(entry.name)) {
        rawCleanupCursor.pendingSession = null;
        continue;
      }
      const path = ingestionRawSessionDirectory(queue, entry.name);
      const opened = await openIngestionRawScanDirectory(path, signal);
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
        await pruneIngestionRawDirectory(path);
        continue;
      }
      budget.remaining -= 1;
      if (!entry.isDirectory() || !isIngestionRawImageName(entry.name)) {
        currentSession.pendingImage = null;
        continue;
      }
      const path = join(currentSession.path, entry.name);
      const opened = await openIngestionRawScanDirectory(path, signal);
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
      await pruneIngestionRawDirectory(path);
      continue;
    }
    budget.remaining -= 1;
    const entry = await ingestionRawFileEntry(
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

async function removeInactiveIngestionRawEntry(
  entry: IngestionRawFileEntry,
  input: Readonly<{
    keep: ReadonlySet<string>;
    rawCutoff: number;
    partCutoff: number;
    signal?: AbortSignal;
  }>
) {
  const identity = rawPathIdentity(entry.path);
  if (input.keep.has(identity) || ingestionRawPathIsActive(entry.path)) {
    return false;
  }
  const cutoff = entry.kind === "part" ? input.partCutoff : input.rawCutoff;
  if (entry.modifiedAt >= cutoff) return false;
  const removed = await tryWithInactiveIngestionRawPath(
    entry.path,
    async () => {
      input.signal?.throwIfAborted();
      if (input.keep.has(identity) || ingestionRawPathIsActive(entry.path)) {
        return false;
      }
      const current = await statIngestionRawIfExists(entry.path);
      input.signal?.throwIfAborted();
      if (!current?.isFile() || current.mtimeMs >= cutoff) return false;
      if (ingestionRawPathIsActive(entry.path)) return false;
      await rm(entry.path, { force: true });
      return true;
    }
  );
  return removed === true;
}

export async function cleanupIngestionRawOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  rawCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
}>) {
  const budget: IngestionRawScanBudget = {
    remaining: appConfig.ingestionRuntime.orphanCleanupMaxRawEntriesPerCycle,
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
      if (await removeInactiveIngestionRawEntry(next.entry, { ...input, keep })) {
        removed += 1;
      }
      acknowledgeRawCleanupFile();
    }
  } catch (error) {
    if (input.stopSignal?.aborted) {
      await closeIngestionRawCleanupCursor();
      input.stopSignal.throwIfAborted();
    }
    if (input.signal?.aborted) {
      // A cycle timeout is a time slice, not a new pass. Keep the bounded
      // three-handle DFS cursor so slow directory prefixes cannot starve the
      // tail forever. Worker stop closes the cursor explicitly above and in
      // IngestionOrphanCleanupWorker.stop().
      return { removed, complete: false };
    }
    await closeIngestionRawCleanupCursor();
    throw error;
  }
  return { removed, complete: false };
}

export async function inspectIngestionRawOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  rawCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
}>) {
  const budget: IngestionRawScanBudget = {
    remaining: appConfig.ingestionRuntime.orphanCleanupMaxRawEntriesPerCycle,
    complete: true
  };
  const keep = new Set([...input.keep].map(rawPathIdentity));
  const summaries = {
    raw: { count: 0, oldest_modified_at: null as number | null },
    part: { count: 0, oldest_modified_at: null as number | null }
  };
  for (const queue of ingestionQueueTypes) {
    for await (const entry of listIngestionRawFiles(queue, budget, input.signal)) {
      input.signal?.throwIfAborted();
      const identity = rawPathIdentity(entry.path);
      if (keep.has(identity) || ingestionRawPathIsActive(entry.path)) continue;
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
