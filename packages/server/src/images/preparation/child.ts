import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { safeFetchExternalImage } from "../../core/external-image-fetch.ts";
import { digestLocalFile, makeDurableDirectory, syncFile } from "../../storage/drivers/local-publication.ts";
import { createVariantEncoder, verifyVariantFile } from "../variants/encoding.ts";
import { processIdentity } from "./process-ownership.ts";
import { nodeReadableFromWeb } from "../../storage/objects/stream-buffer.ts";
import type { PreparationChildCommand, PreparationChildReply } from "./child-protocol.ts";

sharp.concurrency(1);
sharp.cache({ files: 0, memory: 32, items: 32 });
const controller = new AbortController();
let encoder: Awaited<ReturnType<typeof createVariantEncoder>> | undefined;
let busy = false;
const send = (reply: PreparationChildReply) => process.send?.(reply);

async function execute(command: PreparationChildCommand) {
  const signal = controller.signal;
  signal.throwIfAborted();
  switch (command.action) {
    case "open": {
      let input: { sha256: string; bytes: number } | undefined;
      if (command.expectedSha256) {
        try {
          const facts = await digestLocalFile(command.input, signal);
          if (facts.sha256 === command.expectedSha256) input = facts;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!input) {
        await makeDurableDirectory(dirname(command.input));
        // The path is an already registered, attempt-owned checkpoint; no other input is removed.
        await rm(command.input, { force: true });
        const response = await safeFetchExternalImage(command.url, {
          signal, timeoutMs: command.timeoutMs, targetOriginReferer: true, imageValidation: "sniff",
          headers: { Accept: "image/*,*/*", "Accept-Encoding": "identity" }
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`原图下载失败（HTTP ${response.status}）`);
        }
        let bytes = 0;
        await pipeline(
          nodeReadableFromWeb(response.body),
          new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > command.maxBytes ? new Error("原图超过接入体积限制") : null, chunk);
          } }),
          createWriteStream(command.input, { flags: "wx" }), { signal }
        );
        await syncFile(command.input);
        input = await digestLocalFile(command.input, signal);
      }
      encoder = await createVariantEncoder(command.input, command.profile, command.cache, command.maxLongEdge, signal);
      return { input };
    }
    case "encode": {
      if (!encoder) throw new Error("图片编码器尚未初始化");
      return { facts: await encoder.encode(command.variant, command.candidate) };
    }
    case "verify": return { facts: await verifyVariantFile(command.path, signal) };
    case "close": await encoder?.close(); encoder = undefined; return {};
    case "cancel": return {};
  }
}

process.on("message", (command: PreparationChildCommand) => {
  if (command.action === "cancel") { controller.abort(new Error("预生成已停止")); return; }
  if (busy) { send({ id: command.id, error: "子进程只接受串行图片操作" }); return; }
  busy = true;
  void execute(command).then(
    (value) => send({ id: command.id, ...value }),
    (error: unknown) => send({ id: command.id, error: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code })
  ).finally(() => {
    busy = false;
    if (command.action === "close") process.disconnect?.();
  });
});
// A parent can die between its lease loss and a cooperative cancel. An orphan
// never publishes files; killing it also bounds native encoder lifetime.
process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => controller.abort(new Error("预生成子进程退出")));
send({ id: 0, identity: await processIdentity() });
