import type { Dir } from "node:fs";
import { opendir, rmdir } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";

const activeTempPaths = new Map<string, number>();
const deletingTempPaths = new Map<string, Promise<void>>();
const activeTempDirectories = new Map<string, number>();
const pruningTempDirectories = new Map<string, Promise<void>>();
const scanningTempDirectories = new Map<string, number>();

export function tempPathIdentity(path: string) {
  const identity = normalize(resolve(path));
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

async function retainActiveTempPath(identity: string) {
  for (;;) {
    const deleting = deletingTempPaths.get(identity);
    if (deleting) {
      await deleting;
      continue;
    }
    activeTempPaths.set(identity, (activeTempPaths.get(identity) ?? 0) + 1);
    return;
  }
}

function releaseActiveTempPath(identity: string) {
  const count = activeTempPaths.get(identity) ?? 0;
  if (count <= 1) activeTempPaths.delete(identity);
  else activeTempPaths.set(identity, count - 1);
}

export function ingestionTempPathIsActive(path: string) {
  return activeTempPaths.has(tempPathIdentity(path));
}

export async function tryWithInactiveIngestionTempPath<T>(
  path: string,
  work: () => Promise<T>
) {
  const identity = tempPathIdentity(path);
  if (activeTempPaths.has(identity) || deletingTempPaths.has(identity)) {
    return null;
  }
  let settle!: () => void;
  const deleting = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  deletingTempPaths.set(identity, deleting);
  try {
    return await work();
  } finally {
    deletingTempPaths.delete(identity);
    settle();
  }
}

function tempLeaseDirectories(paths: readonly string[]) {
  const directories = new Map<string, string>();
  for (const path of paths) {
    const imageDirectory = resolve(dirname(path));
    const sessionDirectory = resolve(dirname(imageDirectory));
    for (const directory of [imageDirectory, sessionDirectory]) {
      directories.set(tempPathIdentity(directory), directory);
    }
  }
  return [...directories.entries()]
    .map(([identity, path]) => ({ identity, path }))
    .toSorted((left, right) => left.identity.localeCompare(right.identity));
}

async function retainActiveTempDirectory(identity: string) {
  for (;;) {
    const pruning = pruningTempDirectories.get(identity);
    if (pruning) {
      await pruning;
      continue;
    }
    activeTempDirectories.set(
      identity,
      (activeTempDirectories.get(identity) ?? 0) + 1
    );
    return;
  }
}

function releaseActiveTempDirectory(identity: string) {
  const count = activeTempDirectories.get(identity) ?? 0;
  if (count <= 1) activeTempDirectories.delete(identity);
  else activeTempDirectories.set(identity, count - 1);
}

function retainScanningTempDirectory(identity: string) {
  scanningTempDirectories.set(
    identity,
    (scanningTempDirectories.get(identity) ?? 0) + 1
  );
}

function releaseScanningTempDirectory(identity: string) {
  const count = scanningTempDirectories.get(identity) ?? 0;
  if (count <= 1) scanningTempDirectories.delete(identity);
  else scanningTempDirectories.set(identity, count - 1);
}

function ignorableEmptyDirectoryError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT"
    || code === "ENOTEMPTY"
    || code === "EEXIST"
    || code === "EBUSY"
    || code === "EPERM";
}

export async function pruneIngestionTempDirectory(path: string) {
  const identity = tempPathIdentity(path);
  const pending = pruningTempDirectories.get(identity);
  if (pending) return pending;
  if (
    activeTempDirectories.has(identity)
    || scanningTempDirectories.has(identity)
  ) return;
  let settle!: () => void;
  const pruning = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  pruningTempDirectories.set(identity, pruning);
  try {
    await rmdir(path);
  } catch (error) {
    if (!ignorableEmptyDirectoryError(error)) throw error;
  } finally {
    pruningTempDirectories.delete(identity);
    settle();
  }
}

export async function pruneIngestionTempParents(path: string) {
  const imageDirectory = resolve(dirname(path));
  await pruneIngestionTempDirectory(imageDirectory);
  await pruneIngestionTempDirectory(resolve(dirname(imageDirectory)));
}

export async function withActiveIngestionTempPaths<T>(
  paths: readonly string[],
  work: () => Promise<T>
) {
  const directories = tempLeaseDirectories(paths);
  for (const directory of directories) {
    await retainActiveTempDirectory(directory.identity);
  }
  const identities = [...new Set(paths.map(tempPathIdentity))].toSorted();
  for (const identity of identities) await retainActiveTempPath(identity);
  try {
    return await work();
  } finally {
    for (const identity of identities) releaseActiveTempPath(identity);
    for (const directory of directories) {
      releaseActiveTempDirectory(directory.identity);
    }
    for (const directory of directories.toSorted((left, right) => (
      right.path.length - left.path.length
    ))) {
      await pruneIngestionTempDirectory(directory.path).catch(() => undefined);
    }
  }
}

export type IngestionTempScanDirectory = Readonly<{
  path: string;
  identity: string;
  directory: Dir;
}>;

async function closeTempDirectoryBestEffort(directory: Dir | null) {
  await directory?.close().catch(() => undefined);
}

export async function openIngestionTempScanDirectory(
  path: string,
  signal?: AbortSignal
): Promise<IngestionTempScanDirectory | null> {
  const identity = tempPathIdentity(path);
  for (;;) {
    signal?.throwIfAborted();
    const pruning = pruningTempDirectories.get(identity);
    if (pruning) {
      await pruning;
      continue;
    }
    retainScanningTempDirectory(identity);
    let directory: Dir | null = null;
    try {
      try {
        directory = await opendir(path, { bufferSize: 64 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      signal?.throwIfAborted();
      if (!directory) {
        releaseScanningTempDirectory(identity);
        return null;
      }
      return { path, identity, directory };
    } catch (error) {
      await closeTempDirectoryBestEffort(directory);
      releaseScanningTempDirectory(identity);
      throw error;
    }
  }
}

export async function closeIngestionTempScanDirectory(
  state: IngestionTempScanDirectory | null
) {
  if (!state) return;
  await state.directory.close().catch(() => undefined);
  releaseScanningTempDirectory(state.identity);
}
