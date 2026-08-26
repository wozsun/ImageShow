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
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { missingS3Fields, type S3StorageConfig } from "../backends/config.ts";
import { s3CopySource, s3ListPrefix, storageS3ObjectName, type StoragePrefix } from "../objects/keys.ts";
import { openedReadToBuffer } from "../objects/stream-buffer.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageCopyOptions,
  StorageDriver,
  StoragePruneOptions,
  StorageRequestOptions,
  StorageSelfTest
} from "./driver.ts";
import { assertSingleByteRangeSyntax, totalSizeFromContentRange } from "../../core/http/byte-range.ts";
import { normalizeObjectEtag } from "../objects/validator.ts";
import { isS3NotFound } from "../objects/not-found.ts";
import {
  batchStorageKeys,
  type StorageKeyListOptions
} from "../objects/key-listing.ts";
import { S3RequestRuntime } from "./s3-request-runtime.ts";

const S3_LIST_MAX_PAGES = 100_001;
const S3_LIST_MAX_CONSECUTIVE_EMPTY_PAGES = 8;

export type S3CommandClient = {
  send(
    command: unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<unknown>;
  destroy(): void;
};

export type S3BackendDependencies = {
  client?: S3CommandClient;
};

function storageS3Client(config: S3StorageConfig): S3CommandClient {
  const endpoint = /^https:\/\//i.test(config.s3.endpoint) ? config.s3.endpoint : `https://${config.s3.endpoint}`;
  return new S3Client({
    endpoint,
    region: config.s3.region || "auto",
    forcePathStyle: config.s3.force_path_style,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.s3.connect_timeout_seconds * 1000
    }),
    credentials: {
      accessKeyId: config.s3.access_key_id,
      secretAccessKey: config.s3.secret_access_key ?? ""
    }
  }) as unknown as S3CommandClient;
}

export class S3Backend implements StorageDriver {
  private readonly client: S3CommandClient;
  private readonly bucket: string;
  private readonly config: S3StorageConfig;
  private readonly requests: S3RequestRuntime;

  constructor(
    config: S3StorageConfig,
    dependencies: S3BackendDependencies = {}
  ) {
    this.config = config;
    this.client = dependencies.client ?? storageS3Client(config);
    this.bucket = config.s3.bucket;
    this.requests = new S3RequestRuntime({
      idleTimeoutMs: config.s3.idle_timeout_seconds * 1000,
      taskTimeoutMs: config.s3.task_timeout_seconds * 1000
    });
  }

  close() {
    this.client.destroy();
  }

  private name(prefix: StoragePrefix, key: string) {
    return storageS3ObjectName(this.config, prefix, key);
  }

  private send<Output>(
    command: unknown,
    options: StorageRequestOptions = {},
    responseBody?: (result: Output) => Readable | undefined
  ) {
    return this.requests.run(
      (signal) => this.client.send(command, { abortSignal: signal }) as Promise<Output>,
      options,
      responseBody
    );
  }

  private async objectSize(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
    const result = await this.send<{ ContentLength?: number }>(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.name(prefix, key)
    }), options);
    const size = Number(result.ContentLength);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  }

  private async optionalObjectSize(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions
  ) {
    try {
      return await this.objectSize(prefix, key, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      return undefined;
    }
  }

  async exists(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
    try {
      await this.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.name(prefix, key)
        }),
        options
      );
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }

  async openRead(
    prefix: StoragePrefix,
    key: string,
    range?: string,
    options: StorageRequestOptions = {}
  ): Promise<OpenedRead> {
    assertSingleByteRangeSyntax(range);
    let result: GetObjectCommandOutput;
    try {
      result = await this.send<GetObjectCommandOutput>(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.name(prefix, key),
          Range: range
        }),
        options,
        (output) => output.Body as Readable | undefined
      );
    } catch (error) {
      if (isS3NotFound(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 416) {
        const responseHeaders = (error as {
          $response?: { headers?: Record<string, string | string[] | undefined> };
        }).$response?.headers;
        const contentRange = responseHeaders?.["content-range"];
        const headerValue = Array.isArray(contentRange) ? contentRange[0] : contentRange;
        const totalSize = totalSizeFromContentRange(headerValue)
          ?? await this.optionalObjectSize(prefix, key, options);
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
    const size = Number.isSafeInteger(rawSize) && rawSize >= 0
      ? rawSize
      : undefined;
    const contentRange = result.ContentRange;
    const totalSize = totalSizeFromContentRange(contentRange) ?? size;
    const etag = normalizeObjectEtag(result.ETag)
      ?? (result.VersionId ? `"s3-version-${Buffer.from(result.VersionId).toString("base64url")}"` : undefined);
    return {
      body,
      size,
      totalSize: totalSize !== undefined
        && Number.isSafeInteger(totalSize) && totalSize >= 0
        ? totalSize
        : undefined,
      contentRange,
      etag,
      lastModified: result.LastModified?.toUTCString(),
      backend: "s3"
    };
  }

  async readBuffer(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
    const limit = await getInputImageMaxBytes();
    return openedReadToBuffer(
      await this.openRead(prefix, key, undefined, options),
      limit
    );
  }

  async writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    type: string,
    options: StorageRequestOptions = {}
  ) {
    await this.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.name(prefix, key),
      Body: body,
      ContentType: type
    }), options);
  }

  async remove(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
    await this.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.name(prefix, key)
    }), options);
  }

  async copy(
    fromPrefix: CopyPrefix,
    fromKey: string,
    toPrefix: CopyPrefix,
    toKey: string,
    options: StorageCopyOptions = {}
  ) {
    await this.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: s3CopySource(this.config, fromPrefix, fromKey),
      Key: this.name(toPrefix, toKey)
    }), options);
  }

  private async *listedKeys(
    prefixPath: string,
    options: StorageKeyListOptions
  ): AsyncGenerator<string> {
    let token: string | undefined;
    let pageCount = 0;
    let consecutiveEmptyPages = 0;
    const seenTokens = new Set<string>();
    do {
      options.signal?.throwIfAborted();
      pageCount += 1;
      if (pageCount > S3_LIST_MAX_PAGES) {
        throw new ApiError(
          502,
          "storage_list_invalid",
          "S3 object listing exceeded its page limit"
        );
      }
      const result = await this.send<{
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      }>(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefixPath,
        ContinuationToken: token,
        MaxKeys: 1_000
      }), options);
      let pageKeyCount = 0;
      for (const item of result.Contents ?? []) {
        options.signal?.throwIfAborted();
        if (!item.Key || item.Key === prefixPath) continue;
        if (!item.Key.startsWith(prefixPath)) {
          throw new ApiError(
            502,
            "storage_list_invalid",
            "S3 returned an object outside the requested prefix"
          );
        }
        pageKeyCount += 1;
        yield item.Key.slice(prefixPath.length);
      }
      consecutiveEmptyPages = pageKeyCount === 0 && result.IsTruncated
        ? consecutiveEmptyPages + 1
        : 0;
      if (
        consecutiveEmptyPages > S3_LIST_MAX_CONSECUTIVE_EMPTY_PAGES
      ) {
        throw new ApiError(
          502,
          "storage_list_invalid",
          "S3 object listing made no progress across truncated pages"
        );
      }
      const nextToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
      if (result.IsTruncated && !nextToken) {
        throw new ApiError(
          502,
          "storage_list_invalid",
          "S3 returned a truncated page without a continuation token"
        );
      }
      if (nextToken && seenTokens.has(nextToken)) {
        throw new ApiError(
          502,
          "storage_list_invalid",
          "S3 returned a repeated continuation token"
        );
      }
      if (nextToken) seenTokens.add(nextToken);
      token = nextToken;
    } while (token);
  }

  async *listKeys(
    prefix: StoragePrefix,
    options: StorageKeyListOptions = {}
  ) {
    const prefixPath = s3ListPrefix(this.config, prefix);
    return yield* batchStorageKeys(
      this.listedKeys(prefixPath, options),
      options
    );
  }

  async selfTest(
    options: StorageRequestOptions = {}
  ): Promise<StorageSelfTest> {
    const missing = missingS3Fields(this.config.s3);
    if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
    const key = `.storage-test-${randomUUID()}`;
    let result: StorageSelfTest | undefined;
    let testError: unknown;
    try {
      await this.writeBuffer(
        "_uploads",
        key,
        Buffer.from("ok"),
        "text/plain",
        options
      );
      if (!await this.exists("_uploads", key, options)) {
        throw new ApiError(
          502,
          "storage_test_failed",
          "S3 self-test object could not be read back"
        );
      }
      result = {
        backend: "s3",
        writable: true,
        bucket: this.config.s3.bucket,
        endpoint: this.config.s3.endpoint
      };
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    try {
      // A PUT can materialize before its response is lost, so always delete.
      await this.remove("_uploads", key);
      if (await this.exists("_uploads", key)) {
        throw new Error("S3 self-test object still exists after deletion");
      }
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      const failure = new ApiError(
        502,
        "storage_test_cleanup_failed",
        "S3 self-test object could not be fully removed",
        { reason: errorMessage(cleanupError) }
      );
      if (testError) {
        throw new AggregateError(
          [testError, failure],
          "S3 self-test and cleanup both failed"
        );
      }
      throw failure;
    }
    if (testError) throw testError;
    return result!;
  }

  async pruneEmptyDirs(_options?: StoragePruneOptions): Promise<number> {
    return 0;
  }
}
