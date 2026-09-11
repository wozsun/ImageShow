import type { Dir, Dirent } from "node:fs";
import { opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appConfig } from "@imageshow/shared";
import { statIngestionTempIfExists } from "./files.ts";
import {
  closeIngestionTempScanDirectory,
  ingestionTempPathIsActive,
  openIngestionTempScanDirectory,
  pruneIngestionTempDirectory,
  tempPathIdentity,
  tryWithInactiveIngestionTempPath,
  type IngestionTempScanDirectory
} from "./lease-registry.ts";
import {
  ingestionTempRoot,
  ingestionTempSessionDirectory,
  isIngestionTempImageName,
  isIngestionTempSessionName,
  parseIngestionTempFileName
} from "./paths.ts";

async function openDirectoryIfExists(path: string) {
  try {
    return await opendir(path, { bufferSize: 64 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type IngestionTempFileEntry = Readonly<{
  path: string;
  modifiedAt: number;
  kind: "raw" | "part" | "prepared";
  size: number;
}>;

type IngestionTempScanBudget = {
  remaining: number;
  complete: boolean;
};

async function ingestionTempFileEntry(
  imagePath: string,
  file: Dirent,
  signal?: AbortSignal
): Promise<IngestionTempFileEntry | null> {
  if (!file.isFile()) return null;
  const parsedName = parseIngestionTempFileName(file.name);
  if (!parsedName) return null;
  const path = join(imagePath, file.name);
  const info = await statIngestionTempIfExists(path);
  signal?.throwIfAborted();
  if (!info?.isFile()) return null;
  return {
    path,
    modifiedAt: info.mtimeMs,
    kind: parsedName.kind,
    size: info.size
  };
}

async function* directoryEntries(
  path: string,
  budget: IngestionTempScanBudget,
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

async function* listIngestionTempFiles(
  budget: IngestionTempScanBudget,
  signal?: AbortSignal
) {
  const root = ingestionTempRoot();
  for await (const session of directoryEntries(root, budget, signal)) {
    if (!session.isDirectory() || !isIngestionTempSessionName(session.name)) {
      continue;
    }
    const sessionPath = join(root, session.name);
    for await (const image of directoryEntries(sessionPath, budget, signal)) {
      if (!image.isDirectory() || !isIngestionTempImageName(image.name)) continue;
      const imagePath = join(sessionPath, image.name);
      for await (const file of directoryEntries(imagePath, budget, signal)) {
        const entry = await ingestionTempFileEntry(
          imagePath,
          file,
          signal
        );
        if (entry) yield entry;
      }
    }
  }
}

type TempCleanupImageCursor = IngestionTempScanDirectory & {
  pendingFile: Dirent | null;
};

type TempCleanupSessionCursor = IngestionTempScanDirectory & {
  image: TempCleanupImageCursor | null;
  pendingImage: Dirent | null;
};

const tempCleanupCursor: {
  root: Dir | null;
  pendingSession: Dirent | null;
  session: TempCleanupSessionCursor | null;
  passSplit: boolean;
} = {
  root: null,
  pendingSession: null,
  session: null,
  passSplit: false
};

async function closeTempCleanupImage() {
  const image = tempCleanupCursor.session?.image ?? null;
  if (tempCleanupCursor.session) tempCleanupCursor.session.image = null;
  await closeIngestionTempScanDirectory(image);
}

async function closeTempCleanupSession() {
  const session = tempCleanupCursor.session;
  tempCleanupCursor.session = null;
  await closeIngestionTempScanDirectory(session);
}

async function closeTempCleanupRoot() {
  const root = tempCleanupCursor.root;
  tempCleanupCursor.root = null;
  tempCleanupCursor.pendingSession = null;
  await root?.close().catch(() => undefined);
}

function acknowledgeTempCleanupFile() {
  const image = tempCleanupCursor.session?.image;
  if (image) image.pendingFile = null;
}

export async function closeIngestionTempCleanupCursor() {
  await closeTempCleanupImage();
  await closeTempCleanupSession();
  await closeTempCleanupRoot();
  tempCleanupCursor.passSplit = false;
}

type TempCleanupStep =
  | Readonly<{ kind: "file"; entry: IngestionTempFileEntry }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{ kind: "complete"; complete: boolean }>;

async function nextTempCleanupFile(
  budget: IngestionTempScanBudget,
  signal?: AbortSignal
): Promise<TempCleanupStep> {
  for (;;) {
    signal?.throwIfAborted();
    if (budget.remaining <= 0) {
      tempCleanupCursor.passSplit = true;
      return { kind: "paused" };
    }
    if (!tempCleanupCursor.root) {
      tempCleanupCursor.root = await openDirectoryIfExists(ingestionTempRoot());
      signal?.throwIfAborted();
      if (!tempCleanupCursor.root) return { kind: "complete", complete: true };
    }

    const currentSession = tempCleanupCursor.session;
    if (!currentSession) {
      const entry = tempCleanupCursor.pendingSession
        ?? await tempCleanupCursor.root.read();
      tempCleanupCursor.pendingSession = entry;
      signal?.throwIfAborted();
      if (!entry) {
        await closeTempCleanupRoot();
        const complete = !tempCleanupCursor.passSplit;
        tempCleanupCursor.passSplit = false;
        return { kind: "complete", complete };
      }
      budget.remaining -= 1;
      if (!entry.isDirectory() || !isIngestionTempSessionName(entry.name)) {
        tempCleanupCursor.pendingSession = null;
        continue;
      }
      const path = ingestionTempSessionDirectory(entry.name);
      const opened = await openIngestionTempScanDirectory(path, signal);
      tempCleanupCursor.pendingSession = null;
      if (opened) {
        tempCleanupCursor.session = {
          ...opened,
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
        await closeTempCleanupSession();
        await pruneIngestionTempDirectory(path);
        continue;
      }
      budget.remaining -= 1;
      if (!entry.isDirectory() || !isIngestionTempImageName(entry.name)) {
        currentSession.pendingImage = null;
        continue;
      }
      const path = join(currentSession.path, entry.name);
      const opened = await openIngestionTempScanDirectory(path, signal);
      currentSession.pendingImage = null;
      if (opened) {
        currentSession.image = {
          ...opened,
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
      await closeTempCleanupImage();
      await pruneIngestionTempDirectory(path);
      continue;
    }
    budget.remaining -= 1;
    const entry = await ingestionTempFileEntry(
      currentImage.path,
      file,
      signal
    );
    if (entry) return { kind: "file", entry };
    currentImage.pendingFile = null;
  }
}

async function removeInactiveIngestionTempEntry(
  entry: IngestionTempFileEntry,
  input: Readonly<{
    keep: ReadonlySet<string>;
    fileCutoff: number;
    partCutoff: number;
    signal?: AbortSignal;
  }>
) {
  const identity = tempPathIdentity(entry.path);
  if (input.keep.has(identity) || ingestionTempPathIsActive(entry.path)) {
    return false;
  }
  const cutoff = entry.kind === "part" ? input.partCutoff : input.fileCutoff;
  if (entry.modifiedAt >= cutoff) return false;
  const removed = await tryWithInactiveIngestionTempPath(
    entry.path,
    async () => {
      input.signal?.throwIfAborted();
      if (input.keep.has(identity) || ingestionTempPathIsActive(entry.path)) {
        return false;
      }
      const current = await statIngestionTempIfExists(entry.path);
      input.signal?.throwIfAborted();
      if (!current?.isFile() || current.mtimeMs >= cutoff) return false;
      if (ingestionTempPathIsActive(entry.path)) return false;
      await rm(entry.path, { force: true });
      return true;
    }
  );
  return removed === true;
}

export async function cleanupIngestionTempOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  fileCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
}>) {
  const budget: IngestionTempScanBudget = {
    remaining: appConfig.ingestionRuntime.orphanCleanupMaxTempEntriesPerCycle,
    complete: true
  };
  const keep = new Set([...input.keep].map(tempPathIdentity));
  let removed = 0;
  try {
    for (;;) {
      const next = await nextTempCleanupFile(budget, input.signal);
      if (next.kind === "complete") {
        return { removed, complete: next.complete };
      }
      if (next.kind === "paused") break;
      if (await removeInactiveIngestionTempEntry(next.entry, { ...input, keep })) {
        removed += 1;
      }
      acknowledgeTempCleanupFile();
    }
  } catch (error) {
    if (input.stopSignal?.aborted) {
      await closeIngestionTempCleanupCursor();
      input.stopSignal.throwIfAborted();
    }
    if (input.signal?.aborted) {
      // A cycle timeout is a time slice, not a new pass. Keep the bounded
      // three-handle DFS cursor so slow directory prefixes cannot starve the
      // tail forever. Worker stop closes the cursor explicitly above and in
      // IngestionOrphanCleanupWorker.stop().
      return { removed, complete: false };
    }
    await closeIngestionTempCleanupCursor();
    throw error;
  }
  return { removed, complete: false };
}

export async function inspectIngestionTempOrphans(input: Readonly<{
  keep: ReadonlySet<string>;
  fileCutoff: number;
  partCutoff: number;
  signal?: AbortSignal;
}>) {
  const budget: IngestionTempScanBudget = {
    remaining: appConfig.ingestionRuntime.orphanCleanupMaxTempEntriesPerCycle,
    complete: true
  };
  const keep = new Set([...input.keep].map(tempPathIdentity));
  const summaries = {
    raw: { count: 0, oldest_modified_at: null as number | null },
    part: { count: 0, oldest_modified_at: null as number | null },
    prepared: { count: 0, oldest_modified_at: null as number | null }
  };
  let totalBytes = 0;
  let retainedBytes = 0;
  for await (const entry of listIngestionTempFiles(budget, input.signal)) {
    totalBytes += entry.size;
    input.signal?.throwIfAborted();
    const retained = keep.has(tempPathIdentity(entry.path)) || ingestionTempPathIsActive(entry.path);
    if (retained) {
      retainedBytes += entry.size;
      continue;
    }
    const cutoff = entry.kind === "part" ? input.partCutoff : input.fileCutoff;
    if (entry.modifiedAt >= cutoff) continue;
    const summary = summaries[entry.kind];
    summary.count += 1;
    summary.oldest_modified_at = summary.oldest_modified_at === null
      ? entry.modifiedAt
      : Math.min(summary.oldest_modified_at, entry.modifiedAt);
  }
  return {
    ...summaries,
    total_bytes: totalBytes,
    retained_bytes: retainedBytes,
    complete: budget.complete
  };
}
