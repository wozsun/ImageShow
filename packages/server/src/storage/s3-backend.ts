import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput
} from "@aws-sdk/client-s3";
import { ApiError } from "../core/api-error.ts";
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
import { assertSingleByteRangeSyntax, totalSizeFromContentRange } from "../core/byte-range.ts";
import { normalizeObjectEtag } from "./object-validator.ts";
import { isS3NotFound } from "./not-found.ts";

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

  private async objectSize(prefix: StoragePrefix, key: string) {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.name(prefix, key)
    }));
    const size = Number(result.ContentLength);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
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

  async openRead(prefix: StoragePrefix, key: string, range?: string): Promise<OpenedRead> {
    assertSingleByteRangeSyntax(range);
    let result: GetObjectCommandOutput;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name(prefix, key), Range: range }));
    } catch (error) {
      if (isS3NotFound(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 416) {
        const responseHeaders = (error as {
          $response?: { headers?: Record<string, string | string[] | undefined> };
        }).$response?.headers;
        const contentRange = responseHeaders?.["content-range"];
        const headerValue = Array.isArray(contentRange) ? contentRange[0] : contentRange;
        const totalSize = totalSizeFromContentRange(headerValue)
          ?? await this.objectSize(prefix, key).catch(() => undefined);
        throw new ApiError(
          416,
          "range_not_satisfiable",
          "Requested range is not satisfiable",
          totalSize === undefined ? {} : { total_size: totalSize }
        );
      }
      throw error;
    }
    const body = result.Body as Readable | undefined;
    if (!body) throw new ApiError(502, "storage_read_failed", "Storage returned an empty response body");
    const rawSize = Number(result.ContentLength);
    const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined;
    const contentRange = result.ContentRange;
    const totalSize = totalSizeFromContentRange(contentRange) ?? size;
    const etag = normalizeObjectEtag(result.ETag)
      ?? (result.VersionId ? `"s3-version-${Buffer.from(result.VersionId).toString("base64url")}"` : undefined);
    return {
      body,
      size,
      totalSize: Number.isFinite(totalSize) ? totalSize : undefined,
      contentRange,
      etag,
      lastModified: result.LastModified?.toUTCString(),
      backend: "s3"
    };
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
    let written = false;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: "ok", ContentType: "text/plain" }));
      written = true;
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        backend: "s3",
        writable: true,
        bucket: this.config.s3.bucket,
        endpoint: this.config.s3.endpoint,
        public_base_url: this.config.s3.public_base_url
      };
    } finally {
      if (written) {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
        ).catch(() => undefined);
      }
    }
  }

  async pruneEmptyDirs(): Promise<number> {
    return 0;
  }
}
