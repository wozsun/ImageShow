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
import { ApiError } from "../core/http.ts";
import { getInputImageMaxBytes } from "../config/app-settings.ts";
import { missingS3Fields, type StorageConfig } from "./backend-config.ts";
import { s3CopySource, s3ListPrefix, storageS3ObjectName, type ReadablePrefix, type StoragePrefix } from "./object-keys.ts";
import { streamToBuffer } from "./stream-buffer.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./storage-backend.ts";

function storageS3Client(config: StorageConfig) {
  const endpoint = /^https:\/\//i.test(config.s3.endpoint) ? config.s3.endpoint : `https://${config.s3.endpoint}`;
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

/** @internal Exported only for local storage error verification. */
export function isS3NotFound(error: unknown) {
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return maybe?.$metadata?.httpStatusCode === 404 || maybe?.name === "NoSuchKey" || maybe?.name === "NotFound" || maybe?.Code === "NoSuchKey";
}

export class S3Backend implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
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
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }

  async openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) })).catch((error: unknown) => {
      if (isS3NotFound(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      throw error;
    });
    const body = result.Body as Readable | undefined;
    if (!body) throw new ApiError(502, "storage_read_failed", "Storage returned an empty response body");
    const rawSize = Number(result.ContentLength);
    return { body, size: Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined, backend: "s3" };
  }

  async readBuffer(prefix: StoragePrefix, key: string) {
    const limit = await getInputImageMaxBytes();
    const opened = await this.openRead(prefix, key);
    if (opened.size !== undefined && opened.size > limit) {
      opened.body.destroy();
      throw new ApiError(400, "object_too_large", "图片大小超过限制", { limit });
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

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: s3CopySource(this.config, fromPrefix, fromKey),
      Key: this.name(toPrefix, toKey)
    }));
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key) })).catch((error: unknown) => {
      if (isS3NotFound(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      throw error;
    });
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

  async pruneEmptyDirs(): Promise<number> {
    return 0;
  }
}
