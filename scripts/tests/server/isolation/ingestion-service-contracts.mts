import assert from "node:assert/strict";
import { createIngestionScenarioFixture, repositoryWithOverrides } from "./ingestion-scenario-fixture.mts";
import type { IngestionSessionSnapshot, StoredIngestionSession } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import type { IngestionSessionService } from "../../../../packages/server/src/images/ingestion/session-service.ts";
type Dependencies = Required<NonNullable<ConstructorParameters<typeof IngestionSessionService>[2]>>;

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const runtimeConfigStore = await import("../../../../packages/server/src/config/runtime-config-store.ts");
const ingestionSessionService = await import("../../../../packages/server/src/images/ingestion/session-service.ts");
const ingestionTokenService = await import("../../../../packages/server/src/images/ingestion/sessions/token-service.ts");
const coreUuid = await import("../../../../packages/server/src/core/uuid.ts");
  const serviceNow = Date.parse("2026-08-23T01:02:03.456Z");
  const { ingestionRepository } = await createIngestionScenarioFixture(runtime);
  const { readCommittedIngestionResultsByImageIds } = await import("../../../../packages/server/src/images/read-models/ingestion-results.ts");
  const { storageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
  const committedFixtures = async (ids: readonly string[], owners: string[], imageTime: string) => {
    for (const [index, id] of ids.entries()) {
      await runtime.databasePools.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, theme, ext, md5, image_time) VALUES ($1,$2,'local',$3,'pc','dark','none','webp',$4,$5)",
        [id, owners[index], storageObjectKey(id, "webp"), "a".repeat(32), imageTime]
      );
    }
    return readCommittedIngestionResultsByImageIds(ids);
  };
  const serviceDraft = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "none",
    author: "",
    title: "service batch",
    description: "",
    source: "",
    original: "",
    tags: []
  };
  const serviceDependencies = (readCommitted: Dependencies["readCommitted"]): Partial<Dependencies> => ({
    readCommitted
  });
  const serviceTokens = () => new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(19),
    now: () => serviceNow
  });
  const serviceBatchKey = coreUuid.randomUuidV7At(new Date(serviceNow));
  const uploadBatchItems = [
    {
      ...serviceDraft,
      idempotency_key: "upload-batch-first",
      batch_key: serviceBatchKey,
      image_time: "2026-08-23T01:02:03.456Z",
      batch_position: 0,
      expected_size: 10,
      max_long_edge: 100
    },
    {
      ...serviceDraft,
      idempotency_key: "upload-batch-second",
      batch_key: serviceBatchKey,
      image_time: "2026-08-23T01:02:03.456Z",
      batch_position: 1,
      expected_size: 10,
      max_long_edge: 100
    }
  ];
  let uploadBatchCall = 0;
  const uploadBatchService = new ingestionSessionService.IngestionSessionService(repositoryWithOverrides(ingestionRepository, {
    createUploadIntent: async (intent) => {
      uploadBatchCall += 1;
      if (uploadBatchCall === 2) throw new Error("second upload rejected");
      return { kind: "intent" as const, created: true, intent };
    }
  }), serviceTokens(), serviceDependencies(async () => new Map()));
  const uploadBatchResult = await uploadBatchService.createUploadIntents(
    "service-owner",
    uploadBatchItems,
    serviceNow
  );
  assert.equal(uploadBatchCall, 2);
  assert.equal(uploadBatchResult[0].status, "intent");
  assert.deepEqual(uploadBatchResult[1], {
    idempotency_key: "upload-batch-second",
    status: "failed" as const,
    code: "ingestion_item_failed",
    message: "second upload rejected"
  });
  const uploadBoundaryResult = await uploadBatchService.createUploadIntents(
    "service-owner",
    [
      {
        ...uploadBatchItems[0],
        idempotency_key: "upload-size-boundary",
        expected_size: 100 * 1024 * 1024 + 1
      },
      {
        ...uploadBatchItems[0],
        idempotency_key: "upload-edge-boundary",
        max_long_edge: 32_001
      }
    ],
    serviceNow
  );
  assert.deepEqual(
    uploadBoundaryResult.map((item) => { assert.ok(item.status === "failed"); return { status: item.status, code: item.code }; }),
    [
      { status: "failed" as const, code: "upload_too_large" },
      { status: "failed" as const, code: "upload_dimensions_exceeded" }
    ]
  );
  assert.equal(uploadBatchCall, 2, "越界 intent 不得进入存储或 Redis 接管");

  let importBatchCall = 0;
  const importBatchService = new ingestionSessionService.IngestionSessionService(repositoryWithOverrides(ingestionRepository, {
    acceptImportSession: async (template, displayOrderKey, now) => {
      importBatchCall += 1;
      if (importBatchCall === 2) throw new Error("second import rejected");
      return ingestionRepository.acceptImportSession(template, displayOrderKey, now);
    }
  }), serviceTokens(), serviceDependencies(async () => new Map()));
  const importBatchResult = await importBatchService.acceptImportItems(
    "service-owner",
    uploadBatchItems.map((item, index) => ({
      ...item,
      idempotency_key: "import-batch-" + String(index),
      source_type: "url" as const,
      download_url: "https://example.com/" + String(index) + ".jpg"
    })),
    serviceNow
  );
  assert.equal(importBatchCall, 2);
  assert.equal(importBatchResult[0].status, "accepted");
  assert.equal(
    importBatchResult[0].accepted_order,
    1,
    "accept 响应必须携带精确顺序供 snapshot 前的组合总数交接"
  );
  assert.deepEqual(importBatchResult[1], {
    idempotency_key: "import-batch-1",
    status: "failed" as const,
    code: "ingestion_item_failed",
    message: "second import rejected"
  });

  const originalRuntimeConfig = structuredClone(runtimeConfigStore.getRuntimeConfig());
  const policyTemplates: IngestionSessionSnapshot[] = [];
  const policyService = new ingestionSessionService.IngestionSessionService(repositoryWithOverrides(ingestionRepository, {
    acceptImportSession: async (template, displayOrderKey, now) => {
      policyTemplates.push(template);
      return ingestionRepository.acceptImportSession(template, displayOrderKey, now);
    }
  }), serviceTokens(), serviceDependencies(async () => new Map()));
  await runtimeConfigStore.updateRuntimeConfig({
    import: { keep_original_link: ["url", "weibo"] },
    weibo: { source_enabled: false }
  });
  try {
    await policyService.acceptImportItems(
      "metadata-policy-owner",
      (["url", "jsonl", "weibo"] as const).map((sourceType, index) => ({
        ...serviceDraft,
        source: "https://source.example.com/" + sourceType,
        original: "https://submitted.example.com/" + sourceType + ".jpg",
        idempotency_key: "metadata-policy-" + sourceType,
        batch_key: serviceBatchKey,
        source_type: sourceType,
        download_url: "https://download.example.com/" + sourceType + ".jpg",
        batch_position: index
      })),
      serviceNow
    );
  } finally {
    await runtimeConfigStore.updateRuntimeConfig({
      import: {
        keep_original_link: originalRuntimeConfig.import.keep_original_link
      },
      weibo: {
        source_enabled: originalRuntimeConfig.weibo.source_enabled
      }
    });
  }
  assert.deepEqual(
    policyTemplates.map((template) => ({
      source_type: template.source_type,
      download: template.import_download!.url,
      source: template.metadata.source,
      original: template.metadata.original
    })),
    [
      {
        source_type: "url" as const,
        download: "https://download.example.com/url.jpg",
        source: "https://source.example.com/url",
        original: "https://download.example.com/url.jpg"
      },
      {
        source_type: "jsonl" as const,
        download: "https://download.example.com/jsonl.jpg",
        source: "https://source.example.com/jsonl",
        original: ""
      },
      {
        source_type: "weibo" as const,
        download: "https://download.example.com/weibo.jpg",
        source: "",
        original: "https://download.example.com/weibo.jpg"
      }
    ]
  );

  let canonicalBatchCall = 0;
  const staleReceiptDeleted: StoredIngestionSession[] = [];
  let queriedCanonicalIds: string[] = [];
  const canonicalBatchRepository = repositoryWithOverrides(ingestionRepository, {
    createUploadIntent: async (intent) => {
      canonicalBatchCall += 1;
      if (canonicalBatchCall === 1) {
        return {
          kind: "canonical" as const,
          session: {
            owner: intent.owner,
            queue: "upload" as const,
            source_type: "upload" as const,
            session_id: intent.session_id,
            image_id: intent.candidate_image_id,
            image_time: intent.resolved_image_time,
            request_hash: intent.request_hash,
            metadata: intent.metadata,
            storage_slug: intent.storage_slug,
            status: "committing" as const,
            phase: "committing" as const,
            message: "committing",
            progress: null,
            version: 3,
            progress_seq: 0,
            last_semantic_revision: 3,
            accepted_at: serviceNow - 10,
            accepted_order: 1,
            execution_token: "execution",
            raw_generation: "",
            raw_size: 0,
            discard_at: serviceNow + 10_000,
            semantic_hash: "a".repeat(64)
          }
        };
      }
      return {
        kind: "canonical" as const,
        session: {
          owner: intent.owner,
          queue: "upload" as const,
          session_id: intent.session_id,
          image_id: intent.candidate_image_id,
          request_hash: intent.request_hash,
          commit_request_id: "stale-commit",
          commit_intent_hash: "b".repeat(64),
          status: "completed" as const,
          version: 4,
          last_semantic_revision: 4,
          accepted_at: serviceNow - 10,
          accepted_order: 2,
          completed_at: serviceNow - 1,
          discard_at: serviceNow + 10_000
        }
      };
    },
    deleteSession: async (session) => {
      staleReceiptDeleted.push(session);
      return (await ingestionRepository.snapshot(session.owner, session.queue, 0, 0)).metadata;
    }
  });
  const canonicalBatchService = new ingestionSessionService.IngestionSessionService(
    canonicalBatchRepository,
    serviceTokens(),
    serviceDependencies(async (ids) => {
      queriedCanonicalIds = [...ids];
      return committedFixtures(ids, ["service-owner", "different-owner"], "2026-08-20T00:00:00.000Z");
    })
  );
  const canonicalBatchResult = await canonicalBatchService.createUploadIntents(
    "service-owner",
    uploadBatchItems,
    serviceNow
  );
  assert.equal(queriedCanonicalIds.length, 2, "所有 canonical 都必须查询 PostgreSQL");
  assert.equal(canonicalBatchResult[0].status, "completed");
  assert.equal(canonicalBatchResult[0].accepted_order, 1);
  assert.equal(
    canonicalBatchResult[0].resolved_image_time,
    "2026-08-20T00:00:00.000Z",
    "即使 Redis 仍在 committing，PostgreSQL 已存在时也必须返回 completed"
  );
  assert.equal(
    canonicalBatchResult[0].last_semantic_revision,
    undefined,
    "PG 已完成但 Redis 尚未形成 completed 收据时不得伪造精确动作水位"
  );
  assert.deepEqual(canonicalBatchResult[1], {
    idempotency_key: "upload-batch-second",
    status: "failed" as const,
    code: "ingestion_result_missing",
    message: "Redis 完成收据在 PostgreSQL 中没有对应图片，已清除过期收据，请重试"
  });
  assert.equal(staleReceiptDeleted[0]?.status, "completed");

  const exactCompletedService = new ingestionSessionService.IngestionSessionService(repositoryWithOverrides(ingestionRepository, {
    createUploadIntent: async (intent) => ({
      kind: "canonical" as const,
      session: {
        owner: intent.owner,
        queue: "upload" as const,
        session_id: intent.session_id,
        image_id: intent.candidate_image_id,
        request_hash: intent.request_hash,
        commit_request_id: "completed-commit",
        commit_intent_hash: "c".repeat(64),
        status: "completed" as const,
        version: 9,
        last_semantic_revision: 12,
        accepted_at: serviceNow - 10,
        accepted_order: 3,
        completed_at: serviceNow - 1,
        discard_at: serviceNow + 10_000
      }
    })
  }), serviceTokens(), serviceDependencies(async (ids) => committedFixtures(ids, ["service-owner"], "2026-08-20T00:00:02.000Z")));
  const [exactCompletedResult] = await exactCompletedService
    .createUploadIntents("service-owner", [uploadBatchItems[0]], serviceNow);
  assert.equal(exactCompletedResult.status, "completed");
  assert.equal(exactCompletedResult.accepted_order, 3);
  assert.equal(exactCompletedResult.version, 9);
  assert.equal(exactCompletedResult.last_semantic_revision, 12);

});
