import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type DeleteObjectsCommandOutput,
  type GetObjectCommandOutput
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash, randomUUID } from "node:crypto";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { getIngestionMaxFileBytes } from "../../config/app-settings.ts";
import { missingS3Fields, type S3StorageConfig } from "../backends/config.ts";
import { s3CopySource, s3ListPrefix, storageS3ObjectName, type StoragePrefix } from "../objects/keys.ts";
import { openedReadToBuffer } from "../objects/stream-buffer.ts";
import type {
  OpenedRead,
  StorageCopyOptions,
  StorageDriver,
  StorageObjectReference,
  StoragePruneOptions,
  StorageRemoveOptions,
  StorageRequestOptions,
  StorageServerCopyOptions,
  StorageServerCopySource,
  StorageSelfTest,
  StorageStreamWriteOptions
} from "./driver.ts";
import { assertSingleByteRangeSyntax, totalSizeFromContentRange } from "../../core/http/byte-range.ts";
import { normalizeObjectEtag } from "../objects/validator.ts";
import { isS3NotFound } from "../objects/not-found.ts";
import {
  batchStorageKeys,
  type StorageKeyListOptions
} from "../objects/key-listing.ts";
import { S3RequestRuntime } from "./s3-request-runtime.ts";
import {
  removeDriverObjectsAndConfirm,
  storageRemovalFailure,
  type StorageDeleteAttemptResult
} from "./removal.ts";

const S3_LIST_MAX_PAGES = 100_001;
const S3_LIST_MAX_CONSECUTIVE_EMPTY_PAGES = 8;
const S3_DELETE_OBJECTS_MAX_KEYS = 1_000;
const S3_SINGLE_COPY_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function canonicalS3Endpoint(value: string) {
  if (!value.trim()) return "";
  const endpoint = new URL(
    /^https?:\/\//iu.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  );
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/gu, "") || "/";
  return endpoint.toString().replace(/\/$/u, "");
}

function serverCopyCompatibility(config: S3StorageConfig) {
  return createHash("sha256").update(JSON.stringify([
    canonicalS3Endpoint(config.s3.endpoint),
    config.s3.region.trim() || "auto",
    config.s3.access_key_id,
    config.s3.secret_access_key ?? ""
  ])).digest("base64url");
}

function contentMd5FromHex(value: string | undefined) {
  if (!value) return undefined;
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new RangeError("Expected MD5 must contain 32 hexadecimal characters");
  }
  return Buffer.from(value, "hex").toString("base64");
}

function deleteObjectsCommandWithContentMd5(
  input: ConstructorParameters<typeof DeleteObjectsCommand>[0]
) {
  const command = new DeleteObjectsCommand(input);
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as {
        body?: unknown;
        headers: Record<string, string>;
      };
      const body = request.body;
      const bytes = typeof body === "string"
        ? Buffer.from(body)
        : body instanceof Uint8Array
          ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : null;
      if (!bytes) {
        throw new Error("DeleteObjects request body cannot be checksummed");
      }
      request.headers["content-md5"] = createHash("md5")
        .update(bytes)
        .digest("base64");
      return next(args);
    },
    {
      step: "build",
      name: "imageshowDeleteObjectsContentMd5",
      priority: "low"
    }
  );
  return command;
}

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
  private readonly copyCompatibility: string;

  constructor(
    config: S3StorageConfig,
    dependencies: S3BackendDependencies = {}
  ) {
    this.config = config;
    this.client = dependencies.client ?? storageS3Client(config);
    this.bucket = config.s3.bucket;
    this.copyCompatibility = serverCopyCompatibility(config);
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
    const serverCopyValidator = normalizeObjectEtag(result.ETag);
    const etag = serverCopyValidator
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
      ...(serverCopyValidator && !serverCopyValidator.startsWith("W/")
        ? { serverCopyValidator }
        : {}),
      lastModified: result.LastModified?.toUTCString(),
      backend: "s3"
    };
  }

  async readBuffer(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
    const limit = await getIngestionMaxFileBytes();
    return openedReadToBuffer(
      await this.openRead(prefix, key, undefined, options),
      limit
    );
  }

  async writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    contentType: string,
    options: StorageRequestOptions = {}
  ) {
    await this.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.name(prefix, key),
      Body: body,
      ContentType: contentType
    }), options);
  }

  async writeStream(
    prefix: StoragePrefix,
    key: string,
    body: Readable,
    size: number,
    contentType: string,
    options: StorageStreamWriteOptions = {}
  ) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("Storage stream size must be a non-negative safe integer");
    }
    try {
      await this.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.name(prefix, key),
        Body: body,
        ContentLength: size,
        ContentMD5: contentMd5FromHex(options.expectedMd5),
        ContentType: contentType
      }), options);
    } catch (error) {
      if (!body.destroyed && !body.readableEnded) {
        body.destroy(error instanceof Error ? error : undefined);
      }
      throw error;
    } finally {
      if (!body.destroyed && !body.readableEnded) body.destroy();
    }
  }

  private async sendS3DeleteObjectBatches(
    objects: readonly StorageObjectReference[],
    options: StorageRemoveOptions
  ): Promise<StorageDeleteAttemptResult[]> {
    const results = new Array<StorageDeleteAttemptResult>(objects.length);
    for (
      let offset = 0;
      offset < objects.length;
      offset += S3_DELETE_OBJECTS_MAX_KEYS
    ) {
      const chunk = objects.slice(offset, offset + S3_DELETE_OBJECTS_MAX_KEYS);
      if (options.signal?.aborted) {
        const error = storageRemovalFailure(
          options.signal.reason,
          "storage_delete_cancelled"
        );
        for (let index = offset; index < objects.length; index += 1) {
          results[index] = { status: "not_started", error };
        }
        break;
      }
      const names = chunk.map((object) => this.name(object.prefix, object.key));
      let response: DeleteObjectsCommandOutput;
      try {
        response = await this.send<DeleteObjectsCommandOutput>(
          deleteObjectsCommandWithContentMd5({
            Bucket: this.bucket,
            Delete: {
              Objects: names.map((Key) => ({ Key })),
              Quiet: options.quiet ?? true
            }
          }),
          options
        );
      } catch (error) {
        const failure = storageRemovalFailure(
          error,
          "storage_delete_outcome_unknown"
        );
        for (let index = 0; index < chunk.length; index += 1) {
          results[offset + index] = { status: "unknown", error: failure };
        }
        if (options.signal?.aborted) {
          const notStarted = storageRemovalFailure(
            options.signal.reason,
            "storage_delete_cancelled"
          );
          for (
            let index = offset + chunk.length;
            index < objects.length;
            index += 1
          ) {
            results[index] = { status: "not_started", error: notStarted };
          }
          break;
        }
        continue;
      }

      const nameIndexes = new Map(names.map((name, index) => [name, index]));
      let invalidResponse = false;
      const setResult = (
        name: string | undefined,
        result: StorageDeleteAttemptResult
      ) => {
        const index = name === undefined ? undefined : nameIndexes.get(name);
        if (index === undefined || results[offset + index]) {
          invalidResponse = true;
          return;
        }
        results[offset + index] = result;
      };
      for (const item of response.Errors ?? []) {
        setResult(item.Key, {
          status: "failed",
          error: {
            code: item.Code || "storage_delete_failed",
            message: item.Message || "S3 rejected object deletion"
          }
        });
      }
      for (const item of response.Deleted ?? []) {
        setResult(item.Key, { status: "acknowledged" });
      }
      if (invalidResponse) {
        const error = {
          code: "storage_delete_response_invalid",
          message: "S3 returned an invalid multi-object deletion response"
        };
        for (let index = 0; index < chunk.length; index += 1) {
          results[offset + index] = { status: "unknown", error };
        }
        continue;
      }
      for (const [index] of chunk.entries()) {
        if (results[offset + index]) continue;
        results[offset + index] = options.quiet ?? true
          ? { status: "acknowledged" }
          : {
              status: "unknown",
              error: {
                code: "storage_delete_response_incomplete",
                message: "S3 omitted an object from the deletion response"
              }
            };
      }
    }
    return results;
  }

  async removeObjects(
    objects: readonly StorageObjectReference[],
    options: StorageRemoveOptions = {}
  ) {
    return removeDriverObjectsAndConfirm({
      objects,
      options,
      exists: (object, requestOptions) => this.exists(
        object.prefix,
        object.key,
        requestOptions
      ),
      remove: (items, requestOptions) => this.sendS3DeleteObjectBatches(
        items,
        requestOptions
      )
    });
  }

  async copy(
    fromPrefix: StoragePrefix,
    fromKey: string,
    toPrefix: StoragePrefix,
    toKey: string,
    options: StorageCopyOptions = {}
  ) {
    await this.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: s3CopySource(this.config, fromPrefix, fromKey),
      Key: this.name(toPrefix, toKey)
    }), options);
  }

  serverCopySource(
    prefix: StoragePrefix,
    key: string,
    size: number
  ): StorageServerCopySource | undefined {
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    return {
      provider: "s3-copy-v1",
      compatibility: this.copyCompatibility,
      size,
      location: {
        copy_source: s3CopySource(this.config, prefix, key)
      }
    };
  }

  supportsServerCopySource(source: StorageServerCopySource) {
    return source.provider === "s3-copy-v1"
      && source.compatibility === this.copyCompatibility
      && source.size <= S3_SINGLE_COPY_MAX_BYTES
      && typeof source.location.copy_source === "string"
      && source.location.copy_source.length > 0;
  }

  async copyFromServerSource(
    source: StorageServerCopySource,
    toPrefix: StoragePrefix,
    toKey: string,
    options: StorageServerCopyOptions
  ) {
    if (!this.supportsServerCopySource(source)) {
      throw new RangeError("S3 server-side copy contexts are incompatible");
    }
    if (!/^"[^"\r\n]+"$/u.test(options.sourceValidator)) {
      throw new RangeError("S3 server-side copy requires a strong source ETag");
    }
    await this.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: source.location.copy_source,
      CopySourceIfMatch: options.sourceValidator,
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
      // A PUT can materialize before its response is lost or the caller is
      // cancelled. Cleanup therefore uses its own bounded S3 request budget.
      const [removed] = await this.removeObjects([{
        prefix: "_uploads",
        key
      }]);
      if (removed?.status === "failed" || removed?.status === "unknown") {
        throw new Error(removed.error.message);
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
