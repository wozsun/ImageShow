import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

export const temporaryTestRoot = resolve(import.meta.dirname, "../../../tests/tmp");

export async function createTestDirectory(prefix: string) {
  await mkdir(temporaryTestRoot, { recursive: true });
  return mkdtemp(join(temporaryTestRoot, prefix));
}
