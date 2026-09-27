import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "../../config/bootstrap-env.ts";

const root = join(runtimePaths.tempDirectory, "variant-work");

async function ensureScratchRoot() {
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Variant scratch root must be a directory, not a symbolic link");
}

/** Startup owns the application host lock; no encoder or repair can be active yet. */
export async function clearVariantScratchAtStartup() {
  await ensureScratchRoot();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith("work-")) continue;
    await rm(join(root, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}

export async function withVariantScratch<T>(run: (directory: string) => Promise<T>) {
  await ensureScratchRoot();
  const directory = await mkdtemp(join(root, "work-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
