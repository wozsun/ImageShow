import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { STORAGE_PREFIXES } from "./object-keys.ts";

export async function ensureRuntimeDirectories() {
  await mkdir(runtimePaths.configDirectory, { recursive: true });
  await mkdir(runtimePaths.storageDirectory, { recursive: true });
  await mkdir(runtimePaths.logDirectory, { recursive: true });
  await mkdir(runtimePaths.tempDirectory, { recursive: true });
  for (const prefix of STORAGE_PREFIXES) {
    await mkdir(join(runtimePaths.storageDirectory, prefix), { recursive: true });
  }
}
