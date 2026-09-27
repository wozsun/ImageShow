import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

const loadServer = (path) => import(new URL(path, "file:///app/packages/server/dist/"));
const { LocalStorageDriver } = await loadServer("storage/drivers/local.js");
const { safeStoragePath } = await loadServer("storage/objects/keys.js");

test("[Server/local发布] 文件及目录同步失败阻止确认，既有目标重新确认持久化", async (t) => {
  const driver = new LocalStorageDriver();
  const originalOpen = fs.open;
  const originalLink = fs.link;
  const originalRm = fs.rm;
  const events = [];
  let target;
  let failure;
  const injected = Object.assign(new Error("synthetic fsync failure"), { code: "EIO" });
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      const path = String(args[0]);
      events.push(["sync", path]);
      if ((failure === "candidate" && path.includes(".candidate-")) ||
          (failure === "published" && path === dirname(target) && existsSync(target))) throw injected;
      return originalSync();
    };
    return handle;
  });
  t.mock.method(fs, "link", async (...args) => {
    events.push(["link", String(args[1])]);
    return originalLink(...args);
  });
  t.mock.method(fs, "rm", async (...args) => {
    events.push(["remove", String(args[0])]);
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  const targets = [];
  try {
    for (const mode of ["buffer", "stream"]) {
      for (const fault of [undefined, "candidate", "published"]) {
        const key = `.publication-${randomUUID()}/object.webp`;
        target = safeStoragePath("large", key);
        targets.push(target);
        failure = fault;
        events.length = 0;
        const body = Buffer.from("durable publication");
        const write = () => mode === "buffer"
          ? driver.writeBuffer("large", key, body, "image/webp")
          : driver.writeStream("large", key, Readable.from([body]), body.length, "image/webp");
        if (fault) {
          await assert.rejects(write, (error) => error === injected ||
            (error instanceof AggregateError && error.errors.includes(injected)));
          assert.equal(existsSync(target), fault === "published");
          if (fault === "published") {
            await assert.rejects(driver.ensureDurable("large", key), (error) => error === injected);
            failure = undefined;
            await driver.ensureDurable("large", key);
            assert.deepEqual(await fs.readFile(target), body);
          }
        } else {
          await write();
          const publish = events.findIndex(([event]) => event === "link");
          assert.ok(publish > 0);
          assert.ok(events.slice(0, publish).some(([event, path]) => event === "sync" && path.includes(".candidate-")));
          assert.ok(events.slice(publish + 1).some(([event, path]) => event === "sync" && path === dirname(target)));
          const cleanup = events.findIndex(([event]) => event === "remove");
          assert.ok(cleanup > publish);
          assert.ok(events.slice(cleanup + 1).some(([event, path]) => event === "sync" && path === dirname(target)));
          assert.deepEqual(await fs.readFile(target), body);
        }
        assert.deepEqual((await fs.readdir(dirname(target))).filter((name) => name.includes(".candidate-")), []);
      }
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const path of targets) await fs.rm(dirname(path), { recursive: true, force: true });
  }
});
