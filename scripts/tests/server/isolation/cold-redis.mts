import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = resolve(import.meta.dirname, "../../../..");
const moduleUrl = (relativePath: string) => (
  pathToFileURL(resolve(workspace, relativePath)).href
);
import assert from "node:assert/strict";

const [
  mode,
  host,
  port,
  name,
  user,
  password,
  dataDirectory,
  redisHost,
  redisPort
] = process.argv.slice(2);
Object.assign(process.env, {
  DATABASE_HOST: host,
  DATABASE_PORT: port,
  DATABASE_NAME: name,
  DATABASE_USER: user,
  DATABASE_PASSWORD: password,
  IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: dataDirectory,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
  REDIS_DB: "0"
});

const databasePools = await import(moduleUrl("packages/server/src/core/database/pools.ts"));
databasePools.configureDatabasePools({
  host,
  port: Number(port),
  name,
  user,
  password
});
const databaseSchema = await import(moduleUrl("packages/server/src/core/database/schema.ts"));
const redisClient = await import(moduleUrl("packages/server/src/core/redis/client.ts"));
const ingestionSessionRepository = await import(
  moduleUrl("packages/server/src/images/ingestion/repository.ts")
);
const ingestionSessionIdentity = await import(
  moduleUrl("packages/server/src/images/ingestion/sessions/identity.ts")
);
const ingestionSessionProjection = await import(
  moduleUrl("packages/server/src/images/ingestion/sessions/projection.ts")
);
const imageTime = await import(moduleUrl("packages/server/src/images/image-time.ts"));
const imagePaths = await import(moduleUrl("packages/server/src/storage/objects/image-paths.ts"));

const owner = "current-cold-start-owner";
const beforeTime = imageTime.parseImageTime("2026-08-23T06:00:00.000Z");
const beforeSessionId = ingestionSessionIdentity.createIngestionSessionId(
  owner,
  "import",
  "before-flush"
);
const beforeImageId = "019f8457-063a-7021-a580-7a432dc7fd8e";
const persistedImageId = "019f8457-063a-7020-a580-7a432dc7fd8e";
const repository = new ingestionSessionRepository.IngestionSessionRepository(
  redisClient.redis,
  (work: () => Promise<unknown>) => work()
);

try {
  await databaseSchema.initializeDatabaseSchema();
  await redisClient.pingRedis();
  if (mode === "seed") {
    await databasePools.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, "
        + "device, brightness, theme, ext, md5, image_time, title) VALUES "
        + "($1,$2,'local',$3,'pc','dark','none','webp',$4,$5,$6)",
      [
        persistedImageId,
        owner,
        imagePaths.storageObjectKey(persistedImageId, "webp"),
        "8".repeat(32),
        "2026-08-23T05:59:59.000Z",
        "cold start persisted truth"
      ]
    );
    const withoutHash = {
      owner,
      queue: "import",
      source_type: "url",
      session_id: beforeSessionId,
      image_id: beforeImageId,
      image_time: beforeTime.iso,
      request_hash: "7".repeat(64),
      import_download: { url: "https://example.com/before-flush.webp" },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: "none",
        author: "",
        title: "discardable runtime",
        description: "",
        source: "",
        original: "",
        tags: []
      },
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
    await repository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      "019f8457-063a-7000-8000-000000000001",
      21,
      beforeSessionId
    ), Date.now());
    await redisClient.redis.set("imageshow:test:cold-start-marker", "present");
    assert.equal((await databasePools.pool.query(
      "SELECT count(*)::int AS count FROM metadata WHERE id=$1",
      [persistedImageId]
    )).rows[0]?.count, 1);
  } else if (mode === "verify") {
    assert.equal(await redisClient.redis.dbsize(), 0);
    assert.equal(
      await repository.readSession(owner, beforeSessionId),
      null,
      "停机清空后的旧 Redis canonical 必须无条件消失"
    );
    const persisted = (await databasePools.pool.query(
      "SELECT created_by, title FROM metadata WHERE id=$1",
      [persistedImageId]
    )).rows;
    assert.deepEqual(persisted, [{
      created_by: owner,
      title: "cold start persisted truth"
    }]);
    const afterTime = imageTime.parseImageTime("2026-08-23T06:00:01.000Z");
    const afterSessionId = ingestionSessionIdentity.createIngestionSessionId(
      owner,
      "import",
      "after-flush"
    );
    const afterWithoutHash = {
      owner,
      queue: "import",
      source_type: "url",
      session_id: afterSessionId,
      image_id: imageTime.createImageId(afterTime.date, 22),
      image_time: afterTime.iso,
      request_hash: "9".repeat(64),
      import_download: { url: "https://example.com/after-flush.webp" },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: "none",
        author: "",
        title: "new runtime after cold start",
        description: "",
        source: "",
        original: "",
        tags: []
      },
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
    const accepted = await repository.acceptImportSession({
      ...afterWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        afterWithoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      "019f8457-063b-7000-8000-000000000002",
      22,
      afterSessionId
    ), Date.now());
    assert.equal(accepted.session.session_id, afterSessionId);
    assert.ok(await redisClient.redis.dbsize() > 0);
  } else {
    throw new Error("unknown cold Redis helper mode");
  }
} finally {
  redisClient.redis.disconnect();
  await databasePools.closeDatabasePools();
}
