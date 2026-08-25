import type { Redis } from "ioredis";
import { appConfig } from "@imageshow/shared";
import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { runRequiredRedisCommand } from "../../core/runtime-availability.ts";
import {
  importCanonicalKey,
  importCanonicalKeyRoot,
  importCanonicalKeyPrefix,
  importDisplayQueueKey,
  importDisplayQueueKeyRoot,
  importExpiresKey,
  importOwnerQueueKey,
  importOwnerQueueKeyRoot,
  importQueueMetadataKey,
  importQueueMetadataKeyRoot,
  importRunnableKey,
  importSessionKeys,
  importUploadIntentKey
} from "./session-keys.ts";
import {
  metadataFromHashReply,
  parseImportQueueMetadata,
  parseStoredImportSession,
  parseUploadIntent
} from "./session-codec.ts";
import type {
  CompletedImportReceipt,
  DiscardedImportReceipt,
  ImportQueueMetadata,
  ImportQueueSnapshot,
  ImportQueueType,
  ImportSessionPair,
  ImportSessionSnapshot,
  StoredImportSession,
  UploadIntentSnapshot
} from "./session-model.ts";
import { importSessionSemanticHash } from "./session-projection.ts";
import {
  registerImportSessionRedisCommands,
  type ImportSessionRedisClient,
  type ImportSessionRedisCommandName
} from "./session-commands.ts";

export const importSessionIncarnationMismatch = Symbol(
  "import-session-incarnation-mismatch"
);

type ImportRepositoryCommand = <T>(work: () => Promise<T>) => Promise<T>;

function redisJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function importQueueStructureError() {
  return new ApiError(
    503,
    "import_queue_structure_invalid",
    "导入队列结构异常，请停止应用后清空 ImageShow 专用 Redis 逻辑库"
  );
}

function normalizedSemanticSession(next: StoredImportSession): StoredImportSession {
  const value = redisJsonValue(next);
  if (value.status === "completed") {
    const receipt: CompletedImportReceipt = {
      owner: value.owner,
      queue: value.queue,
      session_id: value.session_id,
      image_id: value.image_id,
      request_hash: value.request_hash,
      commit_request_id: value.commit_request_id,
      commit_intent_hash: value.commit_intent_hash,
      status: "completed",
      version: value.version,
      last_semantic_revision: value.last_semantic_revision,
      accepted_at: value.accepted_at,
      accepted_order: value.accepted_order,
      completed_at: value.completed_at,
      ...(value.display ? { display: value.display } : {}),
      discard_at: value.discard_at
    };
    return receipt;
  }
  if (value.status === "discarded") {
    const receipt: DiscardedImportReceipt = {
      owner: value.owner,
      queue: value.queue,
      session_id: value.session_id,
      image_id: value.image_id,
      image_time: value.image_time,
      request_hash: value.request_hash,
      status: "discarded",
      version: value.version,
      last_semantic_revision: value.last_semantic_revision,
      accepted_at: value.accepted_at,
      accepted_order: value.accepted_order,
      discarded_at: value.discarded_at,
      discard_at: value.discard_at
    };
    return receipt;
  }
  return {
    ...value,
    semantic_hash: importSessionSemanticHash(value)
  };
}

function importDomainReplyError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object"
      && error !== null
      && "message" in error
      && typeof error.message === "string"
      ? error.message
      : null;
  if (!message) return null;
  if (/\b(?:IMPORT_QUEUE_STRUCTURE|WRONGTYPE)\b/u.test(message)) {
    return importQueueStructureError();
  }
  if (/\bIMPORT_CANONICAL\b/u.test(message)) {
    return new ApiError(
      409,
      "import_session_state_conflict",
      "导入任务状态与当前操作不一致"
    );
  }
  if (/\bIMPORT_INTENT\b/u.test(message)) {
    return new ApiError(
      409,
      "upload_intent_state_conflict",
      "上传意图状态与当前操作不一致"
    );
  }
  return null;
}

async function runImportRedisCommand<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const domainError = importDomainReplyError(error);
    if (domainError) throw domainError;
    return runRequiredRedisCommand<T>(() => Promise.reject(error));
  }
}

export type ImportQueueMutation = Readonly<{
  owner: string;
  queue: ImportQueueType;
  kind: "semantic" | "progress" | "removed";
  metadata: ImportQueueMetadata;
  session?: StoredImportSession;
  completedItem?: AdminImageListItemDto;
}>;

type MutateSemanticOptions = Readonly<{
  allowStaleSemanticNoOp?: boolean;
  completedItem?: AdminImageListItemDto;
}>;

type ImportQueueListener = (
  event: ImportQueueMutation
) => void | Promise<void>;

function integer(value: unknown, context: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Redis import command returned invalid ${context}`);
  }
  return parsed;
}

function string(value: unknown, context: string) {
  if (typeof value !== "string") {
    throw new Error(`Redis import command returned invalid ${context}`);
  }
  return value;
}

function array(value: unknown, context: string) {
  if (!Array.isArray(value)) {
    throw new Error(`Redis import command returned invalid ${context}`);
  }
  return value;
}

function commandConflict(code: number): never {
  if (code === -1) {
    throw new ApiError(410, "upload_intent_expired", "上传意图已过期，请重新签发");
  }
  if (code === -2) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "同一幂等身份已用于不同导入意图"
    );
  }
  if (code === -3) {
    throw new ApiError(410, "upload_intent_expired", "上传意图已过期，请重新签发");
  }
  if (code === -4) {
    throw new ApiError(409, "import_execution_fenced", "导入执行权已转移");
  }
  throw new Error(`Redis import command returned unexpected status ${code}`);
}

function canonicalReply(
  raw: unknown,
  operation: "create" | "mutate"
) {
  const reply = array(raw, "canonical result");
  const code = integer(reply[0], "canonical status");
  if (code < 0) {
    if (operation === "create") commandConflict(code);
    if (code === -1) {
      throw new ApiError(410, "import_session_missing", "导入任务已过期或被丢弃");
    }
    if (code === -2) {
      throw new ApiError(409, "import_incarnation_conflict", "导入任务身份已被替换");
    }
    if (code === -3) {
      throw new ApiError(409, "import_version_conflict", "导入任务版本已变化");
    }
    if (code === -4) {
      throw new ApiError(409, "import_execution_fenced", "导入执行权已转移");
    }
    if (code === -5) {
      throw new ApiError(410, "import_session_expired", "导入任务已经到期");
    }
    if (code === -6) {
      throw new ApiError(
        409,
        "import_session_not_expired",
        "导入任务的有效期已经刷新"
      );
    }
    commandConflict(code);
  }
  if (![0, 1, 2, 3, 4, 5].includes(code)) commandConflict(code);
  const serialized = string(reply[1] ?? "", "canonical snapshot");
  const metadataJson = string(reply[2], "queue metadata");
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(metadataJson);
  } catch {
    throw new Error("Redis import command returned invalid queue metadata JSON");
  }
  return {
    code,
    session: serialized ? parseStoredImportSession(serialized) : undefined,
    metadata: parseImportQueueMetadata(metadataValue)
  };
}

function intentReply(raw: unknown) {
  const reply = array(raw, "upload-intent result");
  const code = integer(reply[0], "upload-intent status");
  if (code < 0) commandConflict(code);
  const serialized = string(reply[1], "upload-intent snapshot");
  return { code, serialized };
}

function defaultQueueMetadata(
  owner: string,
  queue: ImportQueueType
): ImportQueueMetadata {
  return {
    owner,
    queue,
    revision: 0,
    last_accepted_order: 0,
    total: 0,
    unfinished: 0,
    waiting: 0,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing_resolving: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
}

function parseMetadataJson(value: unknown, context: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(string(value, context));
  } catch {
    throw new Error(`Redis import command returned invalid ${context} JSON`);
  }
  return parseImportQueueMetadata(parsed);
}

export class ImportSessionRepository {
  readonly #client: ImportSessionRedisClient;
  readonly #command: ImportRepositoryCommand;
  readonly #listeners = new Map<string, Set<ImportQueueListener>>();

  constructor(
    client: ImportSessionRedisClient | Pick<Redis, "defineCommand"> = redis,
    command: ImportRepositoryCommand = runImportRedisCommand
  ) {
    this.#client = registerImportSessionRedisCommands(client);
    this.#command = command;
  }

  #run(
    command: ImportSessionRedisCommandName,
    ...arguments_: Array<string | number>
  ) {
    return this.#command(() => this.#client[command](...arguments_));
  }

  #scope(owner: string, queue: ImportQueueType) {
    return `${owner}\0${queue}`;
  }

  #publish(event: ImportQueueMutation) {
    for (const listener of [...(this.#listeners.get(
      this.#scope(event.owner, event.queue)
    ) ?? [])]) {
      try {
        void Promise.resolve(listener(event)).catch((error: unknown) => {
          logger.error("import queue listener failed", error);
        });
      } catch (error) {
        logger.error("import queue listener failed", error);
      }
    }
  }

  subscribe(
    owner: string,
    queue: ImportQueueType,
    listener: ImportQueueListener
  ) {
    const scope = this.#scope(owner, queue);
    const listeners = this.#listeners.get(scope) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(scope);
    };
  }

  async createUploadIntent(intent: UploadIntentSnapshot) {
    const keys = importSessionKeys(
      intent.owner,
      "upload",
      intent.session_id
    );
    const raw = await this.#run(
      "imageshowCreateUploadIntent",
      importUploadIntentKey(intent.owner, intent.session_id),
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      JSON.stringify(intent),
      appConfig.importRuntime.uploadIntentTtlSeconds,
      intent.created_at
    );
    const result = intentReply(raw);
    if (result.code === 2) {
      return {
        kind: "canonical" as const,
        session: parseStoredImportSession(result.serialized)
      };
    }
    return {
      kind: "intent" as const,
      created: result.code === 0,
      intent: parseUploadIntent(result.serialized)
    };
  }

  async readUploadIntent(owner: string, sessionId: string) {
    const raw = await this.#run(
      "imageshowReadUploadIntent",
      importUploadIntentKey(owner, sessionId)
    );
    const reply = array(raw, "upload-intent read");
    const status = integer(reply[0], "upload-intent read status");
    if (status === 0 && reply.length === 1) return null;
    if (status !== 1 || reply.length !== 7) {
      throw new Error("Redis upload-intent read returned an invalid shape");
    }
    const intent = parseUploadIntent(string(reply[1], "upload-intent snapshot"));
    const directFields = [
      intent.session_id,
      intent.candidate_image_id,
      intent.request_hash,
      intent.display_order_key,
      intent.execution_token
    ];
    for (let index = 0; index < directFields.length; index += 1) {
      if (string(reply[index + 2], "upload-intent field") !== directFields[index]) {
        throw new ApiError(
          409,
          "upload_intent_state_conflict",
          "上传意图结构与当前操作不一致"
        );
      }
    }
    if (intent.owner !== owner || intent.session_id !== sessionId) {
      throw new ApiError(
        409,
        "upload_intent_state_conflict",
        "上传意图结构与当前操作不一致"
      );
    }
    return intent;
  }

  async mutateUploadIntent(
    action: "claim" | "heartbeat" | "release",
    owner: string,
    pair: Readonly<{
      session_id: string;
      candidate_image_id: string;
      request_hash: string;
    }>,
    token: string,
    now = Date.now()
  ) {
    const raw = await this.#run(
      "imageshowMutateUploadIntent",
      importUploadIntentKey(owner, pair.session_id),
      action,
      pair.session_id,
      pair.candidate_image_id,
      pair.request_hash,
      token,
      now,
      appConfig.importRuntime.uploadIntentTtlSeconds,
      appConfig.importRuntime.uploadClaimStaleSeconds * 1000
    );
    const reply = array(raw, "upload-intent mutation");
    const code = integer(reply[0], "upload-intent mutation status");
    if (code === -3) {
      throw new ApiError(409, "upload_in_progress", "该图片正在由另一上传请求接收");
    }
    if (code < 0) commandConflict(code);
    return parseUploadIntent(string(reply[1], "upload-intent mutation snapshot"));
  }

  claimUploadIntent(
    owner: string,
    pair: Readonly<{
      session_id: string;
      candidate_image_id: string;
      request_hash: string;
    }>,
    token: string,
    now?: number
  ) {
    return this.mutateUploadIntent("claim", owner, pair, token, now);
  }

  heartbeatUploadIntent(
    owner: string,
    pair: Readonly<{
      session_id: string;
      candidate_image_id: string;
      request_hash: string;
    }>,
    token: string,
    now?: number
  ) {
    return this.mutateUploadIntent("heartbeat", owner, pair, token, now);
  }

  releaseUploadIntent(
    owner: string,
    pair: Readonly<{
      session_id: string;
      candidate_image_id: string;
      request_hash: string;
    }>,
    token: string,
    now?: number
  ) {
    return this.mutateUploadIntent("release", owner, pair, token, now);
  }

  async createCanonical(
    source: "intent" | "remote",
    template: ImportSessionSnapshot,
    executionToken = "",
    now = Date.now(),
    displayOrderKey = ""
  ) {
    const serializedTemplate = redisJsonValue(template);
    const normalizedTemplate = {
      ...serializedTemplate,
      semantic_hash: importSessionSemanticHash(serializedTemplate)
    } as ImportSessionSnapshot;
    const keys = importSessionKeys(
      normalizedTemplate.owner,
      normalizedTemplate.queue,
      normalizedTemplate.session_id
    );
    const ttlSeconds = normalizedTemplate.queue === "upload"
      ? appConfig.importRuntime.uploadSessionIdleTtlSeconds
      : appConfig.importRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowCreateImportCanonical",
      importUploadIntentKey(
        normalizedTemplate.owner,
        normalizedTemplate.session_id
      ),
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      source,
      now,
      ttlSeconds * 1000,
      JSON.stringify(normalizedTemplate),
      executionToken,
      displayOrderKey
    );
    const result = canonicalReply(raw, "create");
    if (!result.session) {
      throw new Error("Redis import creation omitted its canonical snapshot");
    }
    if (result.code === 1) {
      this.#publish({
        owner: normalizedTemplate.owner,
        queue: normalizedTemplate.queue,
        kind: "semantic",
        metadata: result.metadata,
        session: result.session
      });
    }
    return {
      created: result.code === 1,
      session: result.session,
      metadata: result.metadata
    };
  }

  convertUploadIntent(
    template: ImportSessionSnapshot,
    executionToken: string,
    now?: number
  ) {
    return this.createCanonical("intent", template, executionToken, now);
  }

  acceptRemoteSession(
    template: ImportSessionSnapshot,
    displayOrderKey: string,
    now?: number
  ) {
    return this.createCanonical("remote", template, "", now, displayOrderKey);
  }

  async readSession(owner: string, sessionId: string) {
    const result = (await this.#readSessions(owner, [{
      session_id: sessionId,
      image_id: ""
    }]))[0] ?? null;
    if (result === importSessionIncarnationMismatch) {
      throw new Error("Import session read returned an impossible incarnation mismatch");
    }
    return result;
  }

  async readSessions(owner: string, pairs: readonly ImportSessionPair[]) {
    return this.#readSessions(owner, pairs);
  }

  async #readSessions(
    owner: string,
    pairs: readonly Readonly<{ session_id: string; image_id: string }>[]
  ) {
    if (!pairs.length) return [];
    const raw = await this.#run(
      "imageshowReadImportSessions",
      importRunnableKey,
      importExpiresKey,
      importOwnerQueueKey(owner, "upload"),
      importDisplayQueueKey(owner, "upload"),
      importQueueMetadataKey(owner, "upload"),
      importOwnerQueueKey(owner, "import"),
      importDisplayQueueKey(owner, "import"),
      importQueueMetadataKey(owner, "import"),
      owner,
      importCanonicalKeyPrefix(owner),
      pairs.length,
      ...pairs.flatMap((pair) => [pair.session_id, pair.image_id])
    );
    const reply = array(raw, "session list");
    const count = integer(reply[0], "session list count");
    if (count !== pairs.length || reply.length !== count + 1) {
      throw new Error("Redis import session list returned an invalid shape");
    }
    return reply.slice(1).map((value) => {
      const serialized = string(value, "session list item");
      if (!serialized) return null;
      if (serialized === "!incarnation") {
        return importSessionIncarnationMismatch;
      }
      return parseStoredImportSession(serialized);
    });
  }

  async mutateSemantic(
    current: Pick<StoredImportSession, "owner" | "queue"> & ImportSessionPair,
    expectedVersion: number,
    next: StoredImportSession,
    now = Date.now(),
    options: MutateSemanticOptions = {}
  ) {
    const normalizedNext = normalizedSemanticSession(next);
    const keys = importSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.importRuntime.uploadSessionIdleTtlSeconds
      : appConfig.importRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowMutateImportCanonical",
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      "semantic",
      current.session_id,
      current.image_id,
      expectedVersion,
      "",
      now,
      ttlSeconds * 1000,
      JSON.stringify(normalizedNext),
      options.allowStaleSemanticNoOp ? "1" : "0"
    );
    const result = canonicalReply(raw, "mutate");
    if (!result.session) {
      throw new Error("Redis import mutation omitted its canonical snapshot");
    }
    if (result.code !== 0) {
      const eventCompletedItem = result.session.status === "completed"
        && options.completedItem?.id.toLowerCase()
          === result.session.image_id.toLowerCase()
        ? options.completedItem
        : undefined;
      this.#publish({
        owner: current.owner,
        queue: current.queue,
        kind: "semantic",
        metadata: result.metadata,
        session: result.session,
        ...(eventCompletedItem
          ? { completedItem: eventCompletedItem }
          : {})
      });
    }
    return {
      changed: result.code !== 0,
      session: result.session,
      metadata: result.metadata
    };
  }

  async updateProgress(
    current: Pick<ImportSessionSnapshot, "owner" | "queue" | "execution_token">
      & ImportSessionPair,
    expectedVersion: number,
    progress: Readonly<{
      phase: string;
      message: string;
      progress: number | null;
    }>,
    now = Date.now()
  ) {
    return this.#nonSemanticMutation(
      "progress",
      current,
      expectedVersion,
      current.execution_token,
      JSON.stringify(progress),
      now
    );
  }

  async heartbeat(
    current: Pick<ImportSessionSnapshot, "owner" | "queue" | "execution_token">
      & ImportSessionPair,
    expectedVersion: number,
    now = Date.now()
  ) {
    return this.#nonSemanticMutation(
      "heartbeat",
      current,
      expectedVersion,
      current.execution_token,
      "{}",
      now
    );
  }

  async #nonSemanticMutation(
    action: "progress" | "heartbeat",
    current: Pick<ImportSessionSnapshot, "owner" | "queue"> & ImportSessionPair,
    expectedVersion: number,
    executionToken: string,
    payload: string,
    now: number
  ) {
    const keys = importSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.importRuntime.uploadSessionIdleTtlSeconds
      : appConfig.importRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowMutateImportCanonical",
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      action,
      current.session_id,
      current.image_id,
      expectedVersion,
      executionToken,
      now,
      ttlSeconds * 1000,
      payload
    );
    const result = canonicalReply(raw, "mutate");
    if (!result.session) {
      throw new Error("Redis import mutation omitted its canonical snapshot");
    }
    if (action === "progress") {
      this.#publish({
        owner: current.owner,
        queue: current.queue,
        kind: "progress",
        metadata: result.metadata,
        session: result.session
      });
    }
    return result;
  }

  async deleteSession(
    current: (CompletedImportReceipt | DiscardedImportReceipt)
      & ImportSessionPair,
    expectedVersion: number,
    now = Date.now()
  ) {
    const keys = importSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const raw = await this.#run(
      "imageshowMutateImportCanonical",
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      "delete",
      current.session_id,
      current.image_id,
      expectedVersion,
      "",
      now,
      1,
      "{}"
    );
    const result = canonicalReply(raw, "mutate");
    if (current.status !== "discarded") {
      this.#publish({
        owner: current.owner,
        queue: current.queue,
        kind: "removed",
        metadata: result.metadata,
        session: current
      });
    }
    return result.metadata;
  }

  async expireSession(
    current: StoredImportSession,
    expectedVersion: number,
    cutoff: number,
    next?: StoredImportSession
  ) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new RangeError("Redis import expiry cutoff is invalid");
    }
    const terminal = current.status === "completed"
      || current.status === "discarded";
    const validActiveTransition = next?.status === "completed"
      || next?.status === "discarded"
      || next?.status === "resolving";
    if ((terminal && next) || (!terminal && !validActiveTransition)) {
      throw new TypeError(
        terminal
          ? "Terminal import expiry must not include a transition"
          : "Active import expiry requires a completed, discarded, "
            + "or resolving transition"
      );
    }
    const keys = importSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.importRuntime.uploadSessionIdleTtlSeconds
      : appConfig.importRuntime.importSessionIdleTtlSeconds;
    const expectedToken = "execution_token" in current
      ? current.execution_token
      : "";
    const payload = next
      ? JSON.stringify(normalizedSemanticSession(next))
      : "{}";
    const raw = await this.#run(
      "imageshowMutateImportCanonical",
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      "expire",
      current.session_id,
      current.image_id,
      expectedVersion,
      expectedToken,
      cutoff,
      terminal ? 1 : ttlSeconds * 1000,
      payload
    );
    const result = canonicalReply(raw, "mutate");
    if (!terminal && !result.session) {
      throw new Error("Redis import expiry omitted its transition snapshot");
    }
    if ((!terminal && result.code !== 0) || (
      terminal && current.status !== "discarded"
    )) {
      this.#publish({
        owner: current.owner,
        queue: current.queue,
        kind: terminal ? "removed" : "semantic",
        metadata: result.metadata,
        session: result.session ?? current
      });
    }
    return result;
  }

  async snapshot(
    owner: string,
    queue: ImportQueueType,
    offset: number,
    limit: number,
    options: Readonly<{
      excludeItems?: readonly ImportSessionPair[];
      includeItems?: readonly ImportSessionPair[];
    }> = {}
  ): Promise<ImportQueueSnapshot> {
    const excludeItems = options.excludeItems ?? [];
    const includeItems = options.includeItems ?? [];
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || !Number.isSafeInteger(limit)
      || limit < 0
      || limit > appConfig.importRuntime.snapshotMaxItems
      || excludeItems.length > appConfig.imports.batchHardLimit
      || includeItems.length > appConfig.importRuntime.snapshotMaxItems
      || limit + includeItems.length > appConfig.importRuntime.snapshotMaxItems
    ) {
      throw new RangeError("Redis import snapshot range is invalid");
    }
    const raw = await this.#run(
      "imageshowReadImportQueueSnapshot",
      importOwnerQueueKey(owner, queue),
      importDisplayQueueKey(owner, queue),
      importQueueMetadataKey(owner, queue),
      importRunnableKey,
      importExpiresKey,
      offset,
      limit,
      importCanonicalKeyPrefix(owner),
      owner,
      queue,
      appConfig.importRuntime.snapshotMaxItems,
      JSON.stringify(excludeItems),
      JSON.stringify(includeItems),
      appConfig.imports.batchHardLimit
    );
    const reply = array(raw, "queue snapshot");
    const status = integer(reply[0], "queue snapshot status");
    if (status === 0) {
      return {
        metadata: defaultQueueMetadata(owner, queue),
        offset,
        limit,
        items: [],
        staleItems: [...excludeItems]
      };
    }
    if (status !== 1) {
      throw new Error("Redis import snapshot returned an unknown status");
    }
    const metadataLength = integer(reply[1], "queue metadata length");
    if (metadataLength < 0 || metadataLength % 2 !== 0) {
      throw new Error("Redis import snapshot returned invalid metadata length");
    }
    const metadataEnd = 2 + metadataLength;
    const metadata = metadataFromHashReply(reply.slice(2, metadataEnd));
    const itemCount = integer(reply[metadataEnd], "queue snapshot item count");
    const itemStart = metadataEnd + 1;
    const itemEnd = itemStart + itemCount;
    const serialized = reply.slice(itemStart, itemEnd);
    const staleCount = integer(reply[itemEnd], "queue snapshot stale item count");
    const staleValues = reply.slice(itemEnd + 1);
    if (
      itemCount < 0
      || serialized.length !== itemCount
      || staleCount < 0
      || staleValues.length !== staleCount * 2
    ) {
      throw new Error("Redis import snapshot returned an invalid item count");
    }
    return {
      metadata,
      offset,
      limit,
      items: serialized.map((item) => parseStoredImportSession(
        string(item, "queue snapshot item")
      )),
      staleItems: Array.from({ length: staleCount }, (_value, index) => ({
        session_id: string(
          staleValues[index * 2],
          "queue snapshot stale session id"
        ),
        image_id: string(
          staleValues[index * 2 + 1],
          "queue snapshot stale image id"
        )
      }))
    };
  }

  async scanAction(
    owner: string,
    queue: ImportQueueType,
    maximumOrder: number,
    cursor: number,
    limit = appConfig.importRuntime.queueActionBatchSize
  ) {
    if (
      !Number.isSafeInteger(maximumOrder)
      || maximumOrder < 0
      || !Number.isSafeInteger(cursor)
      || cursor < 0
      || cursor > maximumOrder
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > appConfig.importRuntime.queueActionBatchSize
    ) throw new RangeError("Redis import action scan range is invalid");
    const raw = await this.#run(
      "imageshowScanImportQueueAction",
      importOwnerQueueKey(owner, queue),
      importDisplayQueueKey(owner, queue),
      importQueueMetadataKey(owner, queue),
      importRunnableKey,
      importExpiresKey,
      maximumOrder,
      cursor,
      limit,
      importCanonicalKeyPrefix(owner),
      owner,
      queue,
      appConfig.importRuntime.queueActionBatchSize
    );
    const reply = array(raw, "queue action scan");
    const status = integer(reply[0], "queue action scan status");
    if (status === 0) return { items: [], nextCursor: null };
    if (status !== 1 || reply.length < 4) {
      throw new Error("Redis import action scan returned an invalid shape");
    }
    const count = integer(reply[1], "queue action scan count");
    const hasMore = integer(reply[2], "queue action scan continuation");
    const nextCursor = integer(reply[3], "queue action scan cursor");
    const serialized = reply.slice(4);
    if (
      count < 0
      || count > limit
      || serialized.length !== count
      || (hasMore !== 0 && hasMore !== 1)
      || (hasMore === 0 && nextCursor !== 0)
      || (hasMore === 1 && (nextCursor < 1 || nextCursor >= cursor))
    ) {
      throw new Error("Redis import action scan returned invalid bounds");
    }
    return {
      items: serialized.map((item) => parseStoredImportSession(
        string(item, "queue action scan item")
      )),
      nextCursor: hasMore === 1 ? nextCursor : null
    };
  }

  async deleteStaleCompletedReceipts(
    owner: string,
    queue: ImportQueueType,
    receipts: readonly CompletedImportReceipt[]
  ) {
    if (
      receipts.length < 1
      || receipts.length > appConfig.importRuntime
        .snapshotStaleReceiptCleanupBudget
      || receipts.some((receipt) => (
        receipt.owner !== owner
        || receipt.queue !== queue
        || receipt.status !== "completed"
      ))
    ) {
      throw new RangeError("Stale completed receipt batch is invalid");
    }
    const raw = await this.#run(
      "imageshowDeleteStaleCompletedReceipts",
      importOwnerQueueKey(owner, queue),
      importDisplayQueueKey(owner, queue),
      importQueueMetadataKey(owner, queue),
      importRunnableKey,
      importExpiresKey,
      importCanonicalKeyPrefix(owner),
      owner,
      queue,
      JSON.stringify(receipts.map((receipt) => ({
        session_id: receipt.session_id,
        image_id: receipt.image_id,
        version: receipt.version
      }))),
      appConfig.importRuntime.snapshotStaleReceiptCleanupBudget
    );
    const reply = array(raw, "stale completed receipt cleanup");
    const status = integer(reply[0], "stale completed receipt cleanup status");
    if (status === 0) return { removed: 0, metadata: null };
    if (status !== 1) {
      throw new Error("Redis import stale receipt cleanup returned unknown status");
    }
    const metadata = parseMetadataJson(reply[1], "queue metadata");
    for (const receipt of receipts) {
      this.#publish({
        owner,
        queue,
        kind: "removed",
        metadata,
        session: receipt
      });
    }
    return { removed: receipts.length, metadata };
  }

  discoverRunnable(limit = appConfig.importRuntime.recoveryScanBatchSize) {
    return this.#discover(
      importRunnableKey,
      "runnable",
      0,
      limit,
      appConfig.importRuntime.recoveryScanBatchSize,
      0
    );
  }

  discoverRunnablePage(
    cursorScore: number,
    frozenTailScore: number,
    limit = appConfig.importRuntime.recoveryScanBatchSize
  ) {
    return this.#discoverPage(
      importRunnableKey,
      "runnable",
      cursorScore,
      limit,
      appConfig.importRuntime.recoveryScanBatchSize,
      frozenTailScore
    );
  }

  discoverExpired(
    now = Date.now(),
    limit = appConfig.importRuntime.expiryScanBatchSize
  ) {
    return this.#discover(
      importExpiresKey,
      "expires",
      now,
      limit,
      appConfig.importRuntime.expiryScanBatchSize
    );
  }

  discoverExpiryPage(
    offset: number,
    limit = appConfig.importRuntime.recoveryScanBatchSize
  ) {
    return this.#discoverPage(
      importExpiresKey,
      "all",
      offset,
      limit,
      appConfig.importRuntime.recoveryScanBatchSize
    );
  }

  async #discover(
    key: string,
    mode: "runnable" | "expires" | "all",
    bound: number,
    limit: number,
    maximumLimit: number,
    runnableTail = 0
  ) {
    return (await this.#discoverPage(
      key,
      mode,
      bound,
      limit,
      maximumLimit,
      runnableTail
    )).items;
  }

  async #discoverPage(
    key: string,
    mode: "runnable" | "expires" | "all",
    bound: number,
    limit: number,
    maximumLimit: number,
    runnableTail = 0
  ) {
    if (
      !Number.isSafeInteger(bound)
      || bound < 0
      || !Number.isSafeInteger(runnableTail)
      || runnableTail < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > maximumLimit
    ) {
      throw new RangeError("Redis import discovery range is invalid");
    }
    const raw = await this.#run(
      "imageshowDiscoverImportSessions",
      key,
      importRunnableKey,
      importExpiresKey,
      mode,
      bound,
      limit,
      importCanonicalKeyRoot,
      importOwnerQueueKeyRoot,
      importQueueMetadataKeyRoot,
      importDisplayQueueKeyRoot,
      maximumLimit,
      runnableTail
    );
    const reply = array(raw, "session discovery");
    const count = integer(reply[0], "session discovery count");
    const total = integer(reply[1], "session discovery total");
    const scanned = integer(reply[2], "session discovery scanned count");
    const frozenTailScore = integer(reply[3], "session discovery frozen tail");
    const lastScannedScore = integer(reply[4], "session discovery cursor");
    if (
      count < 0
      || total < 0
      || total < scanned
      || scanned < count
      || scanned > limit
      || frozenTailScore < 0
      || lastScannedScore < 0
      || (mode === "runnable" && (
        frozenTailScore < bound
        || lastScannedScore < bound
        || lastScannedScore > frozenTailScore
        || (
          scanned > 0
          && lastScannedScore === bound
          && count > 0
        )
      ))
      || (mode !== "runnable" && (
        frozenTailScore !== 0 || lastScannedScore !== 0
      ))
      || reply.length !== 5 + count * 2
    ) {
      throw new Error("Redis import discovery returned an invalid shape");
    }
    const items = Array.from({ length: count }, (_, index) => {
      const canonicalKey = string(reply[5 + index * 2], "discovery key");
      const session = parseStoredImportSession(string(
        reply[6 + index * 2],
        "discovery snapshot"
      ));
      if (canonicalKey !== importCanonicalKey(
        session.owner,
        session.session_id
      )) throw importQueueStructureError();
      return { canonicalKey, session };
    });
    return {
      items,
      total,
      scanned,
      missing: scanned - count,
      frozenTailScore,
      lastScannedScore
    };
  }
}
