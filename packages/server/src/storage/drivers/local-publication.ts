import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Flush directory entries as well as file contents. Unsupported filesystems fail explicitly. */
export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function makeDurableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  // Another process may have created an ancestor but not yet synced its entry.
  // Existing paths are not proof of durability after an interrupted mkdir.
  let directory = resolve(path);
  while (true) {
    await syncDirectory(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

export async function syncFile(path: string) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

export async function digestLocalFile(path: string, signal?: AbortSignal) {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length;
    md5.update(chunk);
    sha256.update(chunk);
  }
  return { bytes, md5: md5.digest("hex"), sha256: sha256.digest("hex") };
}

/** Caller must own its object's mutation lock and durable publication intent. */
export async function publishLocalCandidate(
  candidate: string,
  target: string,
  options: { replaceOwned?: boolean; signal?: AbortSignal } = {}
) {
  if (dirname(candidate) !== dirname(target)) throw new Error("Candidate must share the target directory");
  options.signal?.throwIfAborted();
  // Once issued, publication must settle even if cancellation arrives meanwhile.
  if (options.replaceOwned) await rename(candidate, target);
  else await link(candidate, target);
  await syncDirectory(dirname(target));
  if (!options.replaceOwned) {
    await unlink(candidate);
    await syncDirectory(dirname(candidate));
  }
}
