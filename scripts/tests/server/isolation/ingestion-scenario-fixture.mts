import type { ImageDraftDto } from "@imageshow/shared/browser";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IngestionPreparedManifest, IngestionSessionSnapshot, StoredIngestionSession } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import type { IntegrationRuntime } from "./integration-runtime.mts";
import type { IngestionSessionRepository } from "../../../../packages/server/src/images/ingestion/repository.ts";

export async function createIngestionScenarioFixture(runtime: IntegrationRuntime) {
  const { requireOperationalRedis } = await import("../../../../packages/server/src/core/runtime-availability.ts");
  await requireOperationalRedis();
  const { IngestionSessionRepository } = await import(
    "../../../../packages/server/src/images/ingestion/repository.ts"
  );
  const identity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
  const { randomUuidV7At } = await import("../../../../packages/server/src/core/uuid.ts");
  const ingestionRepository = new IngestionSessionRepository(runtime.redisClient.redis, (work) => work());
  const productionIngestionRepository = new IngestionSessionRepository(runtime.redisClient.redis);
  const serviceNow = Date.parse("2026-08-23T01:02:03.456Z");
  const displayKeys = new Map<string, string>();
  const displayOrderKey = (sessionId: string, position: number, now = serviceNow) => {
    const existing = displayKeys.get(sessionId);
    if (existing) return existing;
    const key = identity.createIngestionDisplayOrderKey(randomUuidV7At(new Date(now)), position, sessionId);
    displayKeys.set(sessionId, key);
    return key;
  };
  const serviceDraft: ImageDraftDto = {
    device: "auto", brightness: "auto", theme: "none", author: "", title: "service batch",
    description: "", source: "", original: "", tags: []
  };
  const ingestionMetadata: ImageDraftDto = { ...serviceDraft, title: "current domain" };
  const templateId = randomUuidV7At(new Date(serviceNow));
  const importTemplate: Omit<IngestionSessionSnapshot, "semantic_hash"> = {
    owner: "fixture-template", queue: "import", source_type: "url",
    session_id: identity.createIngestionSessionId("fixture-template", "import", "template"),
    image_id: templateId, image_time: new Date(serviceNow).toISOString(),
    request_hash: "d".repeat(64), import_download: { url: "https://example.com/current-domain.jpg" },
    metadata: ingestionMetadata, storage_slug: "local", status: "queued", phase: "queued",
    message: "queued", progress: null, version: 0, progress_seq: 0, last_semantic_revision: 0,
    accepted_at: 0, accepted_order: 0, execution_token: "", raw_generation: "", raw_size: 0, discard_at: 0
  };
  const body = Buffer.from("queue-prepared-fixture");
  const preparedTemplate: IngestionPreparedManifest = {
    prepared_image_key: "template.webp", prepared_thumbnail_key: "template-thumb.webp",
    prepared_image_sha256: createHash("sha256").update(body).digest("hex"),
    prepared_thumbnail_sha256: createHash("sha256").update(body).digest("hex"),
    original_size: body.length, original_width: 1200, original_height: 800,
    width: 1200, height: 800, ext: "webp", md5: createHash("md5").update(body).digest("hex"),
    size: body.length, thumbnail_size: body.length, quality: 90, transcoded: true,
    detected_device: "pc", detected_brightness: "dark", duplicate_count: 0, generation: templateId
  };
  const transitions = await import("../../../../packages/server/src/images/ingestion/sessions/transitions.ts");
  const discardOrderProbe = async (session: IngestionSessionSnapshot, now: number) => {
    const discarded = await ingestionRepository.mutateSemantic(session, session.version,
      transitions.discardedIngestionReceipt(session, now), now);
    await ingestionRepository.deleteSession(terminalSession(discarded.session), discarded.session.version, now + 1);
  };
  return { ingestionRepository, productionIngestionRepository, serviceNow, displayOrderKey, serviceDraft,
    ingestionMetadata, importTemplate, preparedTemplate, discardOrderProbe };
}

export function activeSession(value: StoredIngestionSession | null | undefined): IngestionSessionSnapshot {
  assert.ok(value && value.status !== "completed" && value.status !== "discarded",
    "fixture operation must return an active canonical session");
  return value;
}

export function requiredValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "expected fixture value is missing");
  return value;
}

export function terminalSession(value: StoredIngestionSession | null | undefined) {
  assert.ok(value && (value.status === "completed" || value.status === "discarded"));
  return value;
}

export function completedSession(value: StoredIngestionSession | null | undefined) {
  const session = terminalSession(value);
  assert.equal(session.status, "completed");
  assert.ok(session.status === "completed");
  return session;
}

export function discardedSession(value: StoredIngestionSession | null | undefined) {
  const session = terminalSession(value);
  assert.ok(session.status === "discarded");
  return session;
}

export function activeResult<T extends { session: StoredIngestionSession | null | undefined }>(result: T) {
  return { ...result, session: activeSession(result.session) };
}

export function completedResult<T extends { session: StoredIngestionSession | null | undefined }>(result: T) {
  return { ...result, session: completedSession(result.session) };
}

export function discardedResult<T extends { session: StoredIngestionSession | null | undefined }>(result: T) {
  return { ...result, session: discardedSession(result.session) };
}

export function preparedSession(value: StoredIngestionSession | null | undefined) {
  const session = activeSession(value);
  assert.ok(session.prepared, "prepared canonical must contain its image manifest");
  return { ...session, prepared: session.prepared };
}

export function committingSession(value: StoredIngestionSession | null | undefined) {
  const session = preparedSession(value);
  assert.ok(session.commit, "committing canonical must contain its frozen intent");
  return { ...session, commit: session.commit };
}

/** Keep private repository state on the real instance while intercepting selected operations. */
export function repositoryWithOverrides(
  repository: IngestionSessionRepository,
  overrides: Partial<IngestionSessionRepository>
): IngestionSessionRepository {
  return new Proxy(repository, {
    get(target, key) {
      const source = key in overrides ? overrides : target;
      const value: unknown = Reflect.get(source, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
