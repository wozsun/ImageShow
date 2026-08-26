import type { Redis } from "ioredis";
import { appConfig } from "@imageshow/shared";
import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import {
  ingestionCanonicalKeyPrefix,
  ingestionDisplayQueueKey,
  ingestionExpiresKey,
  ingestionOwnerQueueKey,
  ingestionQueueMetadataKey,
  ingestionRunnableKey,
  ingestionSessionKeys,
  ingestionUploadIntentKey
} from "./sessions/keys.ts";
import {
  parseStoredIngestionSession
} from "./sessions/codec.ts";
import {
  createIngestionSessionCommandRunner,
  type IngestionRepositoryCommand,
  type IngestionSessionCommandRunner
} from "./sessions/command-runner.ts";
import {
  createStoredUploadIntent,
  mutateStoredUploadIntent,
  readStoredUploadIntent
} from "./sessions/intent-store.ts";
import {
  IngestionQueueListenerHub,
  type IngestionQueueListener
} from "./sessions/listener-hub.ts";
import type {
  CompletedIngestionReceipt,
  DiscardedIngestionReceipt,
  IngestionQueueSnapshot,
  IngestionQueueType,
  IngestionSessionPair,
  IngestionSessionSnapshot,
  StoredIngestionSession,
  UploadIntentSnapshot
} from "./sessions/model.ts";
import { ingestionSessionSemanticHash } from "./sessions/projection.ts";
import {
  type IngestionSessionRedisClient
} from "./sessions/commands.ts";
import {
  normalizedSemanticSession,
  parseCanonicalReply,
  redisJsonValue,
  redisReplyArray,
  redisReplyInteger,
  redisReplyString
} from "./sessions/replies.ts";
import {
  deleteStoredCompletedReceipts,
  discoverExpiredIngestionSessions,
  discoverExpiryIngestionSessionPage,
  discoverRunnableIngestionSessionPage,
  discoverRunnableIngestionSessions,
  readIngestionQueueSnapshot,
  scanIngestionQueueAction
} from "./queue/store.ts";

export type { IngestionQueueMutation } from "./sessions/listener-hub.ts";

export const ingestionSessionIncarnationMismatch = Symbol(
  "ingestion-session-incarnation-mismatch"
);

type MutateSemanticOptions = Readonly<{
  allowStaleSemanticNoOp?: boolean;
  completedItem?: AdminImageListItemDto;
}>;

export class IngestionSessionRepository {
  readonly #run: IngestionSessionCommandRunner;
  readonly #listeners = new IngestionQueueListenerHub();

  constructor(
    client?: IngestionSessionRedisClient | Pick<Redis, "defineCommand">,
    command?: IngestionRepositoryCommand
  ) {
    this.#run = createIngestionSessionCommandRunner(client, command);
  }

  subscribe(
    owner: string,
    queue: IngestionQueueType,
    listener: IngestionQueueListener
  ) {
    return this.#listeners.subscribe(owner, queue, listener);
  }

  async createUploadIntent(intent: UploadIntentSnapshot) {
    return createStoredUploadIntent(this.#run, intent);
  }

  async readUploadIntent(owner: string, sessionId: string) {
    return readStoredUploadIntent(this.#run, owner, sessionId);
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
    return mutateStoredUploadIntent(
      this.#run,
      action,
      owner,
      pair,
      token,
      now
    );
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
    acceptance: IngestionQueueType,
    template: IngestionSessionSnapshot,
    executionToken = "",
    now = Date.now(),
    displayOrderKey = ""
  ) {
    const serializedTemplate = redisJsonValue(template);
    const normalizedTemplate = {
      ...serializedTemplate,
      semantic_hash: ingestionSessionSemanticHash(serializedTemplate)
    } as IngestionSessionSnapshot;
    const keys = ingestionSessionKeys(
      normalizedTemplate.owner,
      normalizedTemplate.queue,
      normalizedTemplate.session_id
    );
    const ttlSeconds = normalizedTemplate.queue === "upload"
      ? appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds
      : appConfig.ingestionRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowCreateIngestionCanonical",
      ingestionUploadIntentKey(
        normalizedTemplate.owner,
        normalizedTemplate.session_id
      ),
      keys.canonical,
      keys.owner,
      keys.display,
      keys.metadata,
      keys.runnable,
      keys.expires,
      acceptance,
      now,
      ttlSeconds * 1000,
      JSON.stringify(normalizedTemplate),
      executionToken,
      displayOrderKey
    );
    const result = parseCanonicalReply(raw, "create");
    if (!result.session) {
      throw new Error("Redis ingestion creation omitted its canonical snapshot");
    }
    if (result.code === 1) {
      this.#listeners.publish({
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
    template: IngestionSessionSnapshot,
    executionToken: string,
    now?: number
  ) {
    return this.createCanonical("upload", template, executionToken, now);
  }

  acceptImportSession(
    template: IngestionSessionSnapshot,
    displayOrderKey: string,
    now?: number
  ) {
    return this.createCanonical("import", template, "", now, displayOrderKey);
  }

  async readSession(owner: string, sessionId: string) {
    const result = (await this.#readSessions(owner, [{
      session_id: sessionId,
      image_id: ""
    }]))[0] ?? null;
    if (result === ingestionSessionIncarnationMismatch) {
      throw new Error("Ingestion session read returned an impossible incarnation mismatch");
    }
    return result;
  }

  async readSessions(owner: string, pairs: readonly IngestionSessionPair[]) {
    return this.#readSessions(owner, pairs);
  }

  async #readSessions(
    owner: string,
    pairs: readonly Readonly<{ session_id: string; image_id: string }>[]
  ) {
    if (!pairs.length) return [];
    const raw = await this.#run(
      "imageshowReadIngestionSessions",
      ingestionRunnableKey,
      ingestionExpiresKey,
      ingestionOwnerQueueKey(owner, "upload"),
      ingestionDisplayQueueKey(owner, "upload"),
      ingestionQueueMetadataKey(owner, "upload"),
      ingestionOwnerQueueKey(owner, "import"),
      ingestionDisplayQueueKey(owner, "import"),
      ingestionQueueMetadataKey(owner, "import"),
      owner,
      ingestionCanonicalKeyPrefix(owner),
      pairs.length,
      ...pairs.flatMap((pair) => [pair.session_id, pair.image_id])
    );
    const reply = redisReplyArray(raw, "session list");
    const count = redisReplyInteger(reply[0], "session list count");
    if (count !== pairs.length || reply.length !== count + 1) {
      throw new Error("Redis ingestion session list returned an invalid shape");
    }
    return reply.slice(1).map((value) => {
      const serialized = redisReplyString(value, "session list item");
      if (!serialized) return null;
      if (serialized === "!incarnation") {
        return ingestionSessionIncarnationMismatch;
      }
      return parseStoredIngestionSession(serialized);
    });
  }

  async mutateSemantic(
    current: Pick<StoredIngestionSession, "owner" | "queue"> & IngestionSessionPair,
    expectedVersion: number,
    next: StoredIngestionSession,
    now = Date.now(),
    options: MutateSemanticOptions = {}
  ) {
    const normalizedNext = normalizedSemanticSession(next);
    const keys = ingestionSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds
      : appConfig.ingestionRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowMutateIngestionCanonical",
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
    const result = parseCanonicalReply(raw, "mutate");
    if (!result.session) {
      throw new Error("Redis ingestion mutation omitted its canonical snapshot");
    }
    if (result.code !== 0) {
      const eventCompletedItem = result.session.status === "completed"
        && options.completedItem?.id.toLowerCase()
          === result.session.image_id.toLowerCase()
        ? options.completedItem
        : undefined;
      this.#listeners.publish({
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
    current: Pick<IngestionSessionSnapshot, "owner" | "queue" | "execution_token">
      & IngestionSessionPair,
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
    current: Pick<IngestionSessionSnapshot, "owner" | "queue" | "execution_token">
      & IngestionSessionPair,
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
    current: Pick<IngestionSessionSnapshot, "owner" | "queue"> & IngestionSessionPair,
    expectedVersion: number,
    executionToken: string,
    payload: string,
    now: number
  ) {
    const keys = ingestionSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds
      : appConfig.ingestionRuntime.importSessionIdleTtlSeconds;
    const raw = await this.#run(
      "imageshowMutateIngestionCanonical",
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
    const result = parseCanonicalReply(raw, "mutate");
    if (!result.session) {
      throw new Error("Redis ingestion mutation omitted its canonical snapshot");
    }
    if (action === "progress") {
      this.#listeners.publish({
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
    current: (CompletedIngestionReceipt | DiscardedIngestionReceipt)
      & IngestionSessionPair,
    expectedVersion: number,
    now = Date.now()
  ) {
    const keys = ingestionSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const raw = await this.#run(
      "imageshowMutateIngestionCanonical",
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
    const result = parseCanonicalReply(raw, "mutate");
    if (current.status !== "discarded") {
      this.#listeners.publish({
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
    current: StoredIngestionSession,
    expectedVersion: number,
    cutoff: number,
    next?: StoredIngestionSession
  ) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new RangeError("Redis ingestion expiry cutoff is invalid");
    }
    const terminal = current.status === "completed"
      || current.status === "discarded";
    const validActiveTransition = next?.status === "completed"
      || next?.status === "discarded"
      || next?.status === "resolving";
    if ((terminal && next) || (!terminal && !validActiveTransition)) {
      throw new TypeError(
        terminal
          ? "Terminal ingestion expiry must not include a transition"
          : "Active ingestion expiry requires a completed, discarded, "
            + "or resolving transition"
      );
    }
    const keys = ingestionSessionKeys(
      current.owner,
      current.queue,
      current.session_id
    );
    const ttlSeconds = current.queue === "upload"
      ? appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds
      : appConfig.ingestionRuntime.importSessionIdleTtlSeconds;
    const expectedToken = "execution_token" in current
      ? current.execution_token
      : "";
    const payload = next
      ? JSON.stringify(normalizedSemanticSession(next))
      : "{}";
    const raw = await this.#run(
      "imageshowMutateIngestionCanonical",
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
    const result = parseCanonicalReply(raw, "mutate");
    if (!terminal && !result.session) {
      throw new Error("Redis ingestion expiry omitted its transition snapshot");
    }
    if ((!terminal && result.code !== 0) || (
      terminal && current.status !== "discarded"
    )) {
      this.#listeners.publish({
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
    queue: IngestionQueueType,
    offset: number,
    limit: number,
    options: Readonly<{
      excludeItems?: readonly IngestionSessionPair[];
      includeItems?: readonly IngestionSessionPair[];
    }> = {}
  ): Promise<IngestionQueueSnapshot> {
    return readIngestionQueueSnapshot(
      this.#run,
      owner,
      queue,
      offset,
      limit,
      options
    );
  }

  async scanAction(
    owner: string,
    queue: IngestionQueueType,
    maximumOrder: number,
    cursor: number,
    limit = appConfig.ingestionRuntime.queueActionBatchSize
  ) {
    return scanIngestionQueueAction(
      this.#run,
      owner,
      queue,
      maximumOrder,
      cursor,
      limit
    );
  }

  async deleteStaleCompletedReceipts(
    owner: string,
    queue: IngestionQueueType,
    receipts: readonly CompletedIngestionReceipt[]
  ) {
    const result = await deleteStoredCompletedReceipts(
      this.#run,
      owner,
      queue,
      receipts
    );
    if (result.metadata) {
      for (const receipt of receipts) {
        this.#listeners.publish({
          owner,
          queue,
          kind: "removed",
          metadata: result.metadata,
          session: receipt
        });
      }
    }
    return result;
  }

  discoverRunnable(limit = appConfig.ingestionRuntime.recoveryScanBatchSize) {
    return discoverRunnableIngestionSessions(this.#run, limit);
  }

  discoverRunnablePage(
    cursorScore: number,
    frozenTailScore: number,
    limit = appConfig.ingestionRuntime.recoveryScanBatchSize
  ) {
    return discoverRunnableIngestionSessionPage(
      this.#run,
      cursorScore,
      frozenTailScore,
      limit
    );
  }

  discoverExpired(
    now = Date.now(),
    limit = appConfig.ingestionRuntime.expiryScanBatchSize
  ) {
    return discoverExpiredIngestionSessions(this.#run, now, limit);
  }

  discoverExpiryPage(
    offset: number,
    limit = appConfig.ingestionRuntime.recoveryScanBatchSize
  ) {
    return discoverExpiryIngestionSessionPage(this.#run, offset, limit);
  }

}
