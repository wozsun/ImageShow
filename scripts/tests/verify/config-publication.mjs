import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

// The Linux image owns this disposable directory, separate from its live config.
const directory = `/tmp/config-publication-${randomUUID()}`;
process.env.NODE_ENV = "development";
process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY = directory;
const loadServer = (path) => import(new URL(path, "file:///app/packages/server/dist/"));
const store = await loadServer("config/runtime-config-store.js");

test("[Server/配置] 替换前失败保留旧配置，替换后同步失败阻断写入直到重载确认", async (t) => {
  const initial = store.initializeRuntimeConfig();
  const candidate = structuredClone(initial);
  candidate.site.title = "候选配置";
  const file = `${directory}/config.json`;
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const sync = fs.fsyncSync;
  let failure = "file";
  t.mock.method(fs, "fsyncSync", (fd) => {
    const isDirectory = fs.fstatSync(fd).isDirectory();
    if (failure === (isDirectory ? "directory" : "file")) throw new Error("synthetic sync failure");
    return sync(fd);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.replaceRuntimeConfig(candidate), /synthetic sync failure/);
    assert.deepEqual(read(), initial);
    assert.deepEqual(store.getRuntimeConfig(), initial);
    failure = "directory";
    await assert.rejects(store.replaceRuntimeConfig(candidate), (error) =>
      error.code === "config_publication_uncertain" && error.details.file_state === "candidate");
    assert.deepEqual(read(), candidate);
    assert.deepEqual(store.getRuntimeConfig(), initial);
    failure = "none";
    await assert.rejects(store.replaceRuntimeConfig(initial), (error) =>
      error.status === 409 && error.code === "config_publication_uncertain");
    assert.deepEqual(read(), candidate);
    await assert.rejects(store.reloadRuntimeConfigFromDisk(() => { throw new Error("invalid deployment"); }), /invalid deployment/);
    assert.deepEqual(store.getRuntimeConfig(), initial);
    failure = "directory";
    await assert.rejects(store.reloadRuntimeConfigFromDisk(), (error) => error.code === "config_publication_uncertain");
    failure = "none";
    await store.reloadRuntimeConfigFromDisk();
    assert.deepEqual(store.getRuntimeConfig(), candidate);
    await store.replaceRuntimeConfig(initial);
    assert.deepEqual(read(), initial);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
