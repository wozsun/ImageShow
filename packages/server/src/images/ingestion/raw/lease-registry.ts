import type { Dir } from "node:fs";
import { opendir, rmdir } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";

const activeRawPaths = new Map<string, number>();
const deletingRawPaths = new Map<string, Promise<void>>();
const activeRawDirectories = new Map<string, number>();
const pruningRawDirectories = new Map<string, Promise<void>>();
const scanningRawDirectories = new Map<string, number>();

export function rawPathIdentity(path: string) {
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

export function ingestionRawPathIsActive(path: string) {
  return activeRawPaths.has(rawPathIdentity(path));
}

export async function tryWithInactiveIngestionRawPath<T>(
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

export async function pruneIngestionRawDirectory(path: string) {
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

export async function pruneIngestionRawParents(path: string) {
  const imageDirectory = resolve(dirname(path));
  await pruneIngestionRawDirectory(imageDirectory);
  await pruneIngestionRawDirectory(resolve(dirname(imageDirectory)));
}

export async function withActiveIngestionRawPaths<T>(
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
      await pruneIngestionRawDirectory(directory.path).catch(() => undefined);
    }
  }
}

export type IngestionRawScanDirectory = Readonly<{
  path: string;
  identity: string;
  directory: Dir;
}>;

async function closeRawDirectoryBestEffort(directory: Dir | null) {
  await directory?.close().catch(() => undefined);
}

export async function openIngestionRawScanDirectory(
  path: string,
  signal?: AbortSignal
): Promise<IngestionRawScanDirectory | null> {
  const identity = rawPathIdentity(path);
  for (;;) {
    signal?.throwIfAborted();
    const pruning = pruningRawDirectories.get(identity);
    if (pruning) {
      await pruning;
      continue;
    }
    retainScanningRawDirectory(identity);
    let directory: Dir | null = null;
    try {
      try {
        directory = await opendir(path, { bufferSize: 64 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      signal?.throwIfAborted();
      if (!directory) {
        releaseScanningRawDirectory(identity);
        return null;
      }
      return { path, identity, directory };
    } catch (error) {
      await closeRawDirectoryBestEffort(directory);
      releaseScanningRawDirectory(identity);
      throw error;
    }
  }
}

export async function closeIngestionRawScanDirectory(
  state: IngestionRawScanDirectory | null
) {
  if (!state) return;
  await state.directory.close().catch(() => undefined);
  releaseScanningRawDirectory(state.identity);
}
