import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { S3Client } from "@aws-sdk/client-s3";
import { mergeS3Settings } from "../../../packages/server/src/storage/backends/config.ts";
import { installProperties } from "./property-descriptors.ts";

type RequestRecord = {
  method: string;
  key: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  status: number;
};
type S3Failure = { status: number; code: string; message: string };

/** Real SDK serialization/signing against a disposable, loopback-only object store. */
export async function createS3HttpFixture() {
  const objects = new Map<string, Buffer>();
  const requests: RequestRecord[] = [];
  const state: {
    capability: "enforced" | "ignored" | "unsupported";
    beforeRequest?: (request: RequestRecord) => Promise<void>;
    putError?: (request: RequestRecord) => S3Failure | undefined;
    readBody?: (body: Buffer) => Buffer;
  } = { capability: "enforced" };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url!, "http://127.0.0.1");
      const record: RequestRecord = {
        method: request.method!, key: decodeURIComponent(url.pathname).replace(/^\/[^/]+\//u, ""),
        headers: request.headers, body: Buffer.concat(chunks), status: 200
      };
      requests.push(record);
      await state.beforeRequest?.(record);
      const fail = ({ status, code, message }: S3Failure) => {
        record.status = status;
        response.writeHead(status, { "content-type": "application/xml" });
        response.end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
      };
      if (record.method === "PUT") {
        const injected = state.putError?.(record);
        if (injected) return fail(injected);
        const md5 = request.headers["content-md5"];
        if (md5 && state.capability === "unsupported") {
          return fail({ status: 400, code: "InvalidRequest", message: "Content-MD5 is not supported" });
        }
        if (md5 && state.capability === "enforced"
          && md5 !== createHash("md5").update(record.body).digest("base64")) {
          return fail({ status: 400, code: "BadDigest", message: "The Content-MD5 does not match the body" });
        }
        objects.set(record.key, record.body);
        response.end();
      } else if (record.method === "HEAD" || record.method === "GET") {
        const stored = objects.get(record.key);
        if (!stored) return fail({ status: 404, code: "NoSuchKey", message: "Object not found" });
        const body = record.method === "GET" ? state.readBody?.(stored) ?? stored : stored;
        const range = request.headers.range;
        const bytes = range === "bytes=0-0" ? body.subarray(0, 1) : body;
        record.status = range ? 206 : 200;
        response.writeHead(record.status, {
          "content-length": bytes.length,
          etag: `"${createHash("md5").update(stored).digest("hex")}"`,
          ...(range ? { "content-range": `bytes 0-0/${body.length}` } : {})
        });
        response.end(record.method === "GET" ? bytes : undefined);
      } else if (record.method === "POST" && url.searchParams.has("delete")) {
        const keys = [...record.body.toString().matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => match[1]!);
        for (const key of keys) objects.delete(key);
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(`<DeleteResult>${keys.map((key) => `<Deleted><Key>${key}</Key></Deleted>`).join("")}</DeleteResult>`);
      } else {
        fail({ status: 400, code: "InvalidRequest", message: "Unexpected fixture operation" });
      }
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const originalSend = S3Client.prototype.send;
  // Only redirect the transport address. Production client checksum policy,
  // serialization, body streaming, signing and error decoding remain active.
  const restore = installProperties(S3Client.prototype, {
    send(this: S3Client, ...args: Parameters<S3Client["send"]>) {
      this.middlewareStack.add((next) => async (input) => {
        const request = input.request as { hostname: string; protocol: string; port: number };
        if (!request.hostname.endsWith(".example.test")) {
          throw new Error("S3 fixture only accepts synthetic endpoints");
        }
        request.hostname = "127.0.0.1";
        request.protocol = "http:";
        request.port = port;
        return next(input);
      }, { step: "build", priority: "high", name: "fixtureTransport", override: true });
      return Reflect.apply(originalSend, this, args);
    }
  });
  return {
    objects, requests, state,
    settings: mergeS3Settings({
      endpoint: "https://objects.example.test", region: "test-region", bucket: "images",
      access_key_id: randomUUID(), secret_access_key: randomUUID(), force_path_style: true,
      connect_timeout_seconds: 1, idle_timeout_seconds: 1, task_timeout_seconds: 15
    }),
    async close() {
      restore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
