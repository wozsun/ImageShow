import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createTestDirectory } from "../support/test-directory.ts";

test("[Server/发布] 完整版本检查拒绝任一 manifest、lockfile、分支或标签不一致", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = await createTestDirectory("release-version-");
  const script = "scripts/tests/verify/version-contract.mjs";
  const paths = ["package.json", "packages/server/package.json", "packages/web/package.json", "packages/shared/package.json", "package-lock.json"];
  await mkdir(dirname(join(directory, script)), { recursive: true });
  await copyFile(join(root, script), join(directory, script));
  const original = new Map<string, string>();
  for (const path of paths) {
    const source = await readFile(join(root, path), "utf8");
    original.set(path, source);
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), source);
  }
  const version = JSON.parse(original.get("package.json")!).version;
  const run = (args: string[], refType = "branch", refName = "dev") => execFileSync(process.execPath, [join(directory, script), ...args], {
    encoding: "utf8", stdio: "pipe", env: { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName }
  });
  assert.match(run(["--branch", "dev"]), /manifests and lockfile agree/u);
  assert.match(run(["--tag", `v${version}`], "tag", `v${version}`), /manifests and lockfile agree/u);
  for (const path of paths.slice(0, 4)) {
    await writeFile(join(directory, path), JSON.stringify({ ...JSON.parse(original.get(path)!), version: "0.0.0" }));
    assert.throws(() => run(["--branch", "dev"]), /package versions differ/u);
    assert.throws(() => run(["--tag", `v${version}`]), /package versions differ/u);
    await writeFile(join(directory, path), original.get(path)!);
  }
  for (const key of [null, "", "packages/server", "packages/web", "packages/shared"]) {
    const lock = JSON.parse(original.get("package-lock.json")!);
    if (key === null) lock.version = "0.0.0";
    else lock.packages[key].version = "0.0.0";
    await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock));
    assert.throws(() => run(["--branch", "dev"]), /lockfile versions/u);
    assert.throws(() => run(["--tag", `v${version}`]), /lockfile versions/u);
    await writeFile(join(directory, "package-lock.json"), original.get("package-lock.json")!);
  }
  assert.throws(() => run(["--branch", "dev"], "branch", "main"), /branch main does not match dev/u);
  assert.throws(() => run(["--branch", "dev"], "tag", "dev"), /requires a GitHub branch ref/u);
  for (const tag of ["v0.0.0", version, `v${version}-rc.1`]) {
    assert.throws(() => run(["--tag", tag]), /does not match/u);
  }
});
