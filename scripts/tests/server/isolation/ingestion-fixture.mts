import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type {
  ImageDraftDto,
  IngestionCommitItemInputDto
} from "@imageshow/shared/browser";
import type {
  IngestionPreparedManifest,
  IngestionSessionSnapshot
} from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import type { IntegrationRuntime } from "./integration-runtime.mts";

type CommitIntentModule = typeof import(
  "../../../../packages/server/src/images/ingestion/commit/intent.ts"
);
type CoreUuidModule = typeof import(
  "../../../../packages/server/src/core/uuid.ts"
);
type ImagePathsModule = typeof import(
  "../../../../packages/server/src/storage/objects/image-paths.ts"
);
type ImageTimeModule = typeof import(
  "../../../../packages/server/src/images/image-time.ts"
);
type IngestionIdentityModule = typeof import(
  "../../../../packages/server/src/images/ingestion/sessions/identity.ts"
);
type IngestionKeysModule = typeof import(
  "../../../../packages/server/src/images/ingestion/sessions/keys.ts"
);
type IngestionProjectionModule = typeof import(
  "../../../../packages/server/src/images/ingestion/sessions/projection.ts"
);
type IngestionRepositoryModule = typeof import(
  "../../../../packages/server/src/images/ingestion/repository.ts"
);
type IngestionPathsModule = typeof import(
  "../../../../packages/server/src/images/ingestion/raw/paths.ts"
);
type IngestionTransitionsModule = typeof import(
  "../../../../packages/server/src/images/ingestion/sessions/transitions.ts"
);
type PreparedFilesModule = typeof import(
  "../../../../packages/server/src/images/ingestion/raw/prepared.ts"
);
type StorageObjectPrefix = "full" | "thumbs";

export type ReadyIngestionFixture = {
  commitIntent: CommitIntentModule;
  commitRequest: IngestionCommitItemInputDto;
  finalObjectKey: string;
  finalThumbnailKey: string;
  imageBody: Buffer;
  imageId: string;
  localDriver: Awaited<ReturnType<
    IntegrationRuntime["storageRegistry"]["resolveStorageAccess"]
  >>["driver"];
  owner: string;
  prepared: IngestionPreparedManifest;
  ready: IngestionSessionSnapshot;
  repository: InstanceType<
    IngestionRepositoryModule["IngestionSessionRepository"]
  >;
  repositoryKeys: ReturnType<IngestionKeysModule["ingestionSessionKeys"]>;
  runtime: IntegrationRuntime;
  sessionId: string;
  preparedImageFile: string;
  preparedThumbnailFile: string;
  thumbnailBody: Buffer;
};

async function cleanupFixtureResources(fixture: ReadyIngestionFixture) {
  const {
    finalObjectKey,
    finalThumbnailKey,
    imageId,
    localDriver,
    repositoryKeys,
    runtime,
    preparedImageFile,
    preparedThumbnailFile
  } = fixture;
  const errors: unknown[] = [];
  let guardedObjects: Array<{ key: string; prefix: StorageObjectPrefix }> = [];
  try {
    const jobs = await runtime.databasePools.pool.query<{
      payload: { objects?: Array<{ key?: unknown; prefix?: unknown }> };
    }>(
      "SELECT payload FROM background_job WHERE target_id=$1",
      [imageId]
    );
    guardedObjects = jobs.rows.flatMap(({ payload }) => (
      Array.isArray(payload.objects)
        ? payload.objects.flatMap(({ key, prefix }) => (
            typeof key === "string"
              && (prefix === "full" || prefix === "thumbs")
              ? [{ key, prefix }]
              : []
          ))
        : []
    ));
    await runtime.databasePools.pool.query("DELETE FROM metadata WHERE id=$1", [imageId]);
    await runtime.databasePools.pool.query(
      "DELETE FROM background_job WHERE target_id=$1",
      [imageId]
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    const objects: Array<{ key: string; prefix: StorageObjectPrefix }> = [
      { prefix: "full", key: finalObjectKey },
      { prefix: "thumbs", key: finalThumbnailKey },
      ...guardedObjects
    ];
    const uniqueObjects = [...new Map(
      objects.map((object) => [`${object.prefix}\0${object.key}`, object])
    ).values()];
    await localDriver.removeObjects(uniqueObjects);
  } catch (error) {
    errors.push(error);
  }
  try {
    const { removeIngestionPreparedFiles } = await import("../../../../packages/server/src/images/ingestion/raw/prepared.ts");
    await removeIngestionPreparedFiles([preparedImageFile, preparedThumbnailFile]);
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.redisClient.redis.del(...new Set(Object.values(repositoryKeys)));
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "ingestion fixture cleanup failed");
  }
}

export async function createReadyIngestionFixture(
  runtime: IntegrationRuntime,
  label: string
): Promise<ReadyIngestionFixture> {
  const repositoryModule = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/repository.ts")
  ) as IngestionRepositoryModule;
  const identity = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/sessions/identity.ts")
  ) as IngestionIdentityModule;
  const projection = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/sessions/projection.ts")
  ) as IngestionProjectionModule;
  const transitions = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/sessions/transitions.ts")
  ) as IngestionTransitionsModule;
  const paths = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/raw/paths.ts")
  ) as IngestionPathsModule;
  const sessionKeys = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/sessions/keys.ts")
  ) as IngestionKeysModule;
  const imageTime = await import(
    runtime.moduleUrl("packages/server/src/images/image-time.ts")
  ) as ImageTimeModule;
  const imagePaths = await import(
    runtime.moduleUrl("packages/server/src/storage/objects/image-paths.ts")
  ) as ImagePathsModule;
  const preparedFiles = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/raw/prepared.ts")
  ) as PreparedFilesModule;
  const coreUuid = await import(
    runtime.moduleUrl("packages/server/src/core/uuid.ts")
  ) as CoreUuidModule;
  const commitIntent = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/commit/intent.ts")
  ) as CommitIntentModule;

  const owner = "integration-admin";
  const sessionId = identity.createIngestionSessionId(owner, "import", label);
  const resolvedTime = imageTime.parseImageTime("2026-09-07T00:00:00.000Z");
  const imageId = imageTime.createImageId(
    resolvedTime.date,
    Math.floor(Math.random() * 0xfff)
  );
  const metadata: ImageDraftDto = {
    device: "auto",
    brightness: "auto",
    theme: null,
    author: "",
    title: `integration ${label}`,
    description: "",
    source: "",
    original: "",
    tags: []
  };
  const acceptedAt = Date.now();
  const withoutHash: Omit<IngestionSessionSnapshot, "semantic_hash"> = {
    owner,
    queue: "import",
    source_type: "url",
    session_id: sessionId,
    image_id: imageId,
    image_time: resolvedTime.iso,
    request_hash: createHash("sha256").update(`${label}:${imageId}`).digest("hex"),
    import_download: { url: `https://example.com/${label}.webp` },
    metadata,
    storage_slug: "local",
    status: "queued",
    phase: "queued",
    message: "queued",
    progress: null,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: "",
    raw_size: 0,
    discard_at: 0
  };
  const template: IngestionSessionSnapshot = {
    ...withoutHash,
    semantic_hash: projection.ingestionSessionSemanticHash(withoutHash)
  };
  const generation = coreUuid.randomUuidV7();
  const executionToken = coreUuid.randomUuidV7();
  const preparedInput = {
    session_id: sessionId,
    image_id: imageId,
    generation,
    execution_token: executionToken
  };
  const preparedImageFile = paths.ingestionPreparedFile(preparedInput, "image");
  const preparedThumbnailFile = paths.ingestionPreparedFile(preparedInput, "thumb");
  const imageBody = Buffer.from(`integration-image:${label}:${imageId}`);
  const thumbnailBody = Buffer.from(`integration-thumbnail:${label}:${imageId}`);
  const finalObjectKey = imagePaths.storageObjectKey(imageId, "webp");
  const finalThumbnailKey = imagePaths.thumbnailObjectKey(finalObjectKey);
  const repositoryKeys = sessionKeys.ingestionSessionKeys(owner, "import", sessionId);
  const localAccess = await runtime.storageRegistry.resolveStorageAccess("local");
  const repository = new repositoryModule.IngestionSessionRepository(
    runtime.redisClient.redis
  );
  const prepared: IngestionPreparedManifest = {
    prepared_image_path: preparedImageFile,
    prepared_thumbnail_path: preparedThumbnailFile,
    prepared_image_sha256: createHash("sha256").update(imageBody).digest("hex"),
    prepared_thumbnail_sha256: createHash("sha256").update(thumbnailBody).digest("hex"),
    original_size: imageBody.length,
    original_width: 1200,
    original_height: 800,
    width: 1200,
    height: 800,
    ext: "webp",
    md5: createHash("md5").update(imageBody).digest("hex"),
    size: imageBody.length,
    thumbnail_size: thumbnailBody.length,
    quality: 90,
    transcoded: true,
    detected_device: "pc",
    detected_brightness: "dark",
    duplicate_count: 0,
    generation
  };
  const commitRequest: IngestionCommitItemInputDto = {
    session_id: sessionId,
    image_id: imageId,
    expected_version: 0,
    expected_md5: prepared.md5,
    commit_request_id: randomUUID(),
    duplicate_decision: "upload",
    metadata
  };

  let fixture: ReadyIngestionFixture | undefined;
  try {
    await preparedFiles.writeIngestionPreparedFile(preparedImageFile, imageBody, new AbortController().signal);
    await preparedFiles.writeIngestionPreparedFile(preparedThumbnailFile, thumbnailBody, new AbortController().signal);
    const queued = (await repository.acceptImportSession(
      template,
      identity.createIngestionDisplayOrderKey(
        coreUuid.randomUuidV7At(new Date(acceptedAt)),
        0,
        sessionId
      ),
      acceptedAt
    )).session;
    assert.notEqual(queued.status, "completed");
    assert.notEqual(queued.status, "discarded");
    if (queued.status === "completed" || queued.status === "discarded") {
      throw new Error("new ingestion canonical unexpectedly became terminal");
    }
    const ready = (await repository.mutateSemantic(
      queued,
      queued.version,
      transitions.semanticIngestionSession(queued, {
        status: "ready",
        phase: "ready",
        message: "ready",
        progress: 100,
        execution_token: "",
        prepared
      }),
      acceptedAt + 1
    )).session;
    assert.equal(ready.status, "ready");
    commitRequest.expected_version = ready.version;
    fixture = {
      commitIntent,
      commitRequest,
      finalObjectKey,
      finalThumbnailKey,
      imageBody,
      imageId,
      localDriver: localAccess.driver,
      owner,
      prepared,
      ready,
      repository,
      repositoryKeys,
      runtime,
      sessionId,
      preparedImageFile,
      preparedThumbnailFile,
      thumbnailBody
    };
    return fixture;
  } catch (error) {
    const cleanupTarget = fixture ?? {
        commitIntent,
        commitRequest,
        finalObjectKey,
        finalThumbnailKey,
        imageBody,
        imageId,
        localDriver: localAccess.driver,
        owner,
        prepared,
        ready: template,
        repository,
        repositoryKeys,
        runtime,
        sessionId,
        preparedImageFile,
        preparedThumbnailFile,
        thumbnailBody
      } satisfies ReadyIngestionFixture;
    try {
      await cleanupFixtureResources(cleanupTarget);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ingestion fixture setup and cleanup failed"
      );
    }
    throw error;
  }
}

export async function freezeFixtureCommit(fixture: ReadyIngestionFixture) {
  const [result] = await fixture.commitIntent.acceptIngestionCommitIntents(
    fixture.repository,
    fixture.owner,
    [fixture.commitRequest]
  );
  assert.equal(result?.status, "accepted");
  const committing = await fixture.repository.readSession(
    fixture.owner,
    fixture.sessionId
  );
  assert.equal(committing?.status, "committing");
  assert.ok(committing && "commit" in committing && committing.commit);
  return committing;
}

export async function runWithReadyIngestionFixture(
  runtime: IntegrationRuntime,
  label: string,
  work: (fixture: ReadyIngestionFixture) => Promise<void>
) {
  const fixture = await createReadyIngestionFixture(runtime, label);
  const errors: unknown[] = [];
  try {
    await work(fixture);
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanupFixtureResources(fixture);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "ingestion fixture scenario and cleanup failed");
  }
}
