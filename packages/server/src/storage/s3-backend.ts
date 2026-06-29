// S3-compatible object-storage backend. Stateless apart from the client it builds
// from its bound config; every key flows through object-keys so it agrees with
// listings and deletes.
import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { ApiError } from "../core/http.js";
import { getUploadLimitBytes, missingS3Fields, type StorageConfig } from "../config/settings.js";
import { s3CopySource, s3ListPrefix, storageS3ObjectName, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
import { limitedWebStream, nodeReadableFromWeb, streamToBuffer } from "./stream-buffer.js";
import type {
  CopyPrefix,
  MoveFromPrefix,
  MoveToPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./storage-backend.js";

// Builds an S3 client for a backend config.
function storageS3Client(config: StorageConfig) {
  const endpoint = /^https?:\/\//i.test(config.s3.endpoint) ? config.s3.endpoint : `https://${config.s3.endpoint}`;
  return new S3Client({
    endpoint,
    region: config.s3.region || "auto",
    forcePathStyle: config.s3.force_path_style,
    credentials: {
      accessKeyId: config.s3.access_key_id,
      secretAccessKey: config.s3.secret_access_key ?? ""
    }
  });
}

export class S3Backend implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: StorageConfig) {
    this.client = storageS3Client(config);
    this.bucket = config.s3.bucket;
  }

  private name(prefix: StoragePrefix, key: string) {
    return storageS3ObjectName(this.config, prefix, key);
  }

  async exists(prefix: StoragePrefix, key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) }));
      return true;
    } catch {
      return false;
    }
  }

  async openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) }));
    const body = result.Body as Readable | undefined;
    if (!body) throw new ApiError(502, "storage_read_failed", "Storage returned an empty response body");
    const rawSize = Number(result.ContentLength);
    return { body, size: Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined, backend: "s3" };
  }

  async readBuffer(prefix: StoragePrefix, key: string) {
    const limit = await getUploadLimitBytes();
    const opened = await this.openRead(prefix, key);
    if (opened.size !== undefined && opened.size > limit) {
      opened.body.destroy();
      throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
    }
    try {
      return await streamToBuffer(opened.body, limit);
    } catch (error) {
      opened.body.destroy();
      throw error;
    }
  }

  async writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key), Body: body, ContentType: type }));
  }

  async remove(prefix: StoragePrefix, key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) }));
  }

  async move(fromPrefix: MoveFromPrefix, fromKey: string, toPrefix: MoveToPrefix, toKey: string, targetContentType?: string) {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: s3CopySource(this.config, fromPrefix, fromKey),
      Key: this.name(toPrefix, toKey),
      ...(targetContentType ? { ContentType: targetContentType, MetadataDirective: "REPLACE" as const } : {})
    }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.name(fromPrefix, fromKey) }));
  }

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: s3CopySource(this.config, fromPrefix, fromKey),
      Key: this.name(toPrefix, toKey)
    }));
  }

  async writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number) {
    // Stream straight to S3 with a known length instead of buffering the whole
    // body in memory. The size cap is enforced inline; the exact-size and MD5
    // checks still run against the stored object during upload completion.
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.name("_uploads", id),
      Body: nodeReadableFromWeb(limitedWebStream(body, expectedSize)),
      ContentLength: expectedSize,
      ContentType: "application/octet-stream"
    }));
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) }));
    return result.Body as Readable;
  }

  async listKeys(prefix: StoragePrefix) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const prefixPath = s3ListPrefix(this.config, prefix);
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefixPath, ContinuationToken: token }));
      for (const item of result.Contents ?? []) {
        if (!item.Key || item.Key === prefixPath) continue;
        const key = item.Key.startsWith(prefixPath) ? item.Key.slice(prefixPath.length) : item.Key;
        if (prefix === "objects" && /^(thumbs|_uploads|trash|link)\//.test(key)) continue;
        keys.push(key);
      }
      token = result.NextContinuationToken;
    } while (token);
    return keys;
  }

  publicObjectUrl(prefix: ReadablePrefix, key: string) {
    if (!this.config.s3.public_base_url) return "";
    const base = this.config.s3.public_base_url.replace(/\/+$/, "");
    const encoded = this.name(prefix, key).split("/").map(encodeURIComponent).join("/");
    return `${base}/${encoded}`;
  }

  async selfTest(): Promise<StorageSelfTest> {
    const missing = missingS3Fields(this.config.s3);
    if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
    const key = storageS3ObjectName(this.config, "_uploads", `.storage-test-${Date.now()}`);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: "ok", ContentType: "text/plain" }));
    await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return {
      backend: "s3",
      writable: true,
      bucket: this.config.s3.bucket,
      endpoint: this.config.s3.endpoint,
      public_base_url: this.config.s3.public_base_url
    };
  }

  // Object storage has no real directories (keys are flat), so nothing to prune.
  async pruneEmptyDirs(): Promise<number> {
    return 0;
  }
}
