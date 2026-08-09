import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const buildOutputs = [
  "dist",
  "packages/shared/dist",
  "packages/server/dist",
  "packages/web/dist"
];

export async function cleanBuildOutput() {
  await Promise.all(buildOutputs.map((output) => rm(
    resolve(workspaceRoot, output),
    { recursive: true, force: true }
  )));
  console.log(`clean: removed ${buildOutputs.join(", ")}`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await cleanBuildOutput();
}
