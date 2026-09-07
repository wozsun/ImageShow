import assert from "node:assert/strict";
import { Dir, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { installProperties } from "../../support/property-descriptors.ts";
import { activeSession, createIngestionScenarioFixture, repositoryWithOverrides, requiredValue } from "./ingestion-scenario-fixture.mts";
import { createMaintenanceFixture, settleWithin, waitForStorageLockWait } from "./storage-maintenance-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const fixture = await createIngestionScenarioFixture(runtime);
  const { ingestionRepository: repository } = fixture;
  const { body } = await createMaintenanceFixture(runtime);
  const { appConfig } = await import("@imageshow/shared");
  const { randomUuidV7, randomUuidV7At } = await import("../../../../packages/server/src/core/uuid.ts");
  const identity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
  const { ingestionSessionSemanticHash } = await import("../../../../packages/server/src/images/ingestion/sessions/projection.ts");
  const { semanticIngestionSession } = await import("../../../../packages/server/src/images/ingestion/sessions/transitions.ts");
  const { IngestionSessionService } = await import("../../../../packages/server/src/images/ingestion/session-service.ts");
  const { IngestionTokenService } = await import("../../../../packages/server/src/images/ingestion/sessions/token-service.ts");
  const { receiveUploadIntentBody } = await import("../../../../packages/server/src/images/ingestion/raw/upload.ts");
  const raw = await import("../../../../packages/server/src/images/ingestion/raw/paths.ts");
  const { removeIngestionRaw } = await import("../../../../packages/server/src/images/ingestion/raw/files.ts");
  const scanner = await import("../../../../packages/server/src/images/ingestion/raw/orphan-scanner.ts");
  const { prepareIngestionSessionSnapshot } = await import("../../../../packages/server/src/images/ingestion/workers/prepare-session.ts");
  const { withNormalizationAdmission } = await import("../../../../packages/server/src/images/normalization-admission.ts");
  const { cancelIngestionSessions } = await import("../../../../packages/server/src/images/ingestion/cancel/coordinator.ts");
  const { IngestionIrreversibleCoordinator } = await import("../../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts");
  const previous = structuredClone(runtime.runtimeConfigStore.getRuntimeConfig());
  const protectedRawPaths = new Set<string>();
  await runtime.runtimeConfigStore.updateRuntimeConfig({ upload: { raw_concurrency: 1 }, normalize: { concurrency: 1 } });
  try {
    const claimOrder: string[] = [];
    const releaseOrder: string[] = [];
    const intentPositions = new Map<string, number>();
    const claimed = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    const observedUploadRepository = repositoryWithOverrides(repository, {
      claimUploadIntent: async (...args) => {
        claimOrder.push(args[1].session_id);
        const result = await repository.claimUploadIntent(...args);
        claimed[requiredValue(intentPositions.get(args[1].session_id))]!.resolve();
        return result;
      },
      releaseUploadIntent: async (...args) => {
        const result = await repository.releaseUploadIntent(...args);
        releaseOrder.push(args[1].session_id);
        return result;
      }
    });
    const service = new IngestionSessionService(observedUploadRepository,
      new IngestionTokenService({ rootKey: new Uint8Array(32).fill(39) }));
    const batchKey = randomUuidV7();
    const intents = (await service.createUploadIntents("raw-lock-owner", Array.from({ length: 3 }, (_, index) => ({
      ...fixture.serviceDraft, idempotency_key: "raw-lock-" + index, batch_key: batchKey, batch_position: index,
      expected_size: body.length, max_long_edge: 16
    })))).map((intent, index) => {
      assert.ok(intent.status === "intent");
      intentPositions.set(intent.session_id, index);
      return intent;
    });
    const blocker = await runtime.databasePools.pool.connect();
    const stops = intents.map(() => new AbortController());
    const reasons = intents.map((_, index) => new Error("cancel raw lock waiter " + index));
    const pendingUploads: Array<ReturnType<typeof receiveUploadIntentBody>> = [];
    const startUpload = (index: number) => {
      const pending = receiveUploadIntentBody(service, "raw-lock-owner", intents[index]!.credential,
        new Response(body).body, stops[index]!.signal);
      void pending.catch(() => undefined);
      pendingUploads.push(pending);
      return pending;
    };
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext($1))", ["imageshow:storage-location"]);
      startUpload(0);
      await waitForStorageLockWait(runtime.databasePools.pool, true);
      for (const [index, intent] of intents.entries()) {
        if (index + 1 < intents.length) {
          startUpload(index + 1);
          await nextTurn();
          assert.deepEqual(claimOrder, intents.slice(0, index + 1).map(item => item.session_id),
            "a queued raw request must not claim an intent while the sole admission is occupied");
        }
        const reason = reasons[index]!;
        stops[index]!.abort(reason);
        await assert.rejects(settleWithin(pendingUploads[index]!), error => error === reason
          || error instanceof Error && error.name === "AbortError" && error.cause === reason);
        assert.equal(await repository.readSession("raw-lock-owner", intent.session_id), null);
        assert.equal(requiredValue(await repository.readUploadIntent("raw-lock-owner", intent.session_id)).execution_token, "");
        assert.deepEqual(releaseOrder, intents.slice(0, index + 1).map(item => item.session_id),
          "each cancelled admitted request must release its claim exactly once");
        if (index + 1 < intents.length) {
          await settleWithin(Promise.race([
            claimed[index + 1]!.promise,
            pendingUploads[index + 1]!.then(() => assert.fail("queued raw request ended before claim"))
          ]));
        }
      }
      assert.deepEqual(claimOrder, intents.map(item => item.session_id));
    } finally {
      stops.forEach((stop, index) => stop.abort(reasons[index]));
      await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", ["imageshow:storage-location"]);
      blocker.release();
      await Promise.allSettled(pendingUploads);
    }
    const sharedLockWaiters = async () => Number((await runtime.databasePools.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() "
        + "AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' "
        + "AND query LIKE '%pg_advisory_lock_shared%'"
    )).rows[0]!.count);
    const drainDeadline = Date.now() + 5_000;
    while (await sharedLockWaiters() > 0 && Date.now() < drainDeadline) await nextTurn();
    assert.equal(await sharedLockWaiters(), 0, "cancelled raw requests must drain their advisory lock waits");
    const { withStorageLocationReadLock } = await import("../../../../packages/server/src/storage/maintenance-lock.ts");
    assert.equal(await withStorageLocationReadLock(async () => true), true);
    const intent = intents[0]!;
    const received = activeSession(await settleWithin(receiveUploadIntentBody(service, "raw-lock-owner", intent.credential, new Response(body).body)));
    assert.equal(received.status, "received");
    assert.deepEqual(await readFile(raw.ingestionRawPath("upload", received, received.raw_generation)), body);
    protectedRawPaths.add(raw.ingestionRawPath("upload", received, received.raw_generation));

    const createRawSession = async (label: string, status: "preparing" | "failed") => {
      const now = Date.now();
      const sessionId = identity.createIngestionSessionId("raw-session-owner", "import", label);
      const template = { ...fixture.importTemplate, owner: "raw-session-owner", session_id: sessionId,
        image_id: randomUuidV7At(new Date(now)), image_time: new Date(now).toISOString() };
      const queued = activeSession((await repository.acceptImportSession({ ...template,
        semantic_hash: ingestionSessionSemanticHash(template) }, fixture.displayOrderKey(sessionId, 0, now), now)).session);
      const session = activeSession((await repository.mutateSemantic(queued, queued.version, semanticIngestionSession(queued, {
        status, phase: status === "preparing" ? "prepare-waiting" : "failed", message: status,
        execution_token: status === "preparing" ? randomUuidV7() : "", raw_generation: randomUuidV7(), raw_size: body.length
      }))).session);
      const path = raw.ingestionRawPath("import", session, session.raw_generation);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
      return { session, path };
    };
    const preparing = await createRawSession("normalization-lease", "preparing");
    const blockerEntered = Promise.withResolvers<void>();
    const blockerGate = Promise.withResolvers<void>();
    const transcodeEntered = Promise.withResolvers<void>();
    const transcodeGate = Promise.withResolvers<void>();
    const normalizationBlocker = withNormalizationAdmission(new AbortController().signal, async () => { blockerEntered.resolve(); await blockerGate.promise; });
    const prepareStop = new AbortController();
    const prepareReason = new Error("cancel admitted transcode");
    let pendingPrepare: Promise<unknown> | undefined;
    let admissions = 0;
    const progress: string[] = [];
    try {
      await settleWithin(blockerEntered.promise);
      const observedRepository = repositoryWithOverrides(repository, {
        updateProgress: async (...args) => { progress.push(args[2].phase); return repository.updateProgress(...args); }
      });
      pendingPrepare = prepareIngestionSessionSnapshot(observedRepository, preparing.session, prepareStop.signal, {
        onNormalizationAdmitted: () => { admissions += 1; },
        transcode: async (_path, _settings, signal) => {
          assert.equal(signal, prepareStop.signal);
          transcodeEntered.resolve(); await transcodeGate.promise;
          prepareStop.signal.throwIfAborted();
          assert.fail("controlled transcode must be cancelled");
        }
      });
      void pendingPrepare.catch(() => undefined);
      await nextTurn();
      assert.deepEqual(progress, []);
      assert.equal(admissions, 0);
      blockerGate.resolve(); await normalizationBlocker;
      await settleWithin(Promise.race([transcodeEntered.promise, pendingPrepare.then(() => assert.fail("transcode must start"))]));
      assert.equal(admissions, 1);
      assert.equal(progress[0], "normalizing");
      await removeIngestionRaw("import", preparing.session, preparing.session.raw_generation);
      assert.deepEqual(await readFile(preparing.path), body);
      prepareStop.abort(prepareReason);
      await removeIngestionRaw("import", preparing.session, preparing.session.raw_generation);
      assert.deepEqual(await readFile(preparing.path), body, "in-flight transcode retains the raw lease after cancellation");
      transcodeGate.resolve();
      await assert.rejects(settleWithin(pendingPrepare), error => error === prepareReason);
      assert.deepEqual(await readFile(preparing.path), body);
      await removeIngestionRaw("import", preparing.session, preparing.session.raw_generation);
      await assert.rejects(stat(preparing.path), { code: "ENOENT" });
    } finally {
      prepareStop.abort(prepareReason); blockerGate.resolve(); transcodeGate.resolve();
      await Promise.allSettled([normalizationBlocker, ...(pendingPrepare ? [pendingPrepare] : [])]);
    }

    const retired = await createRawSession("delayed-retirement", "failed");
    const scheduled: Array<() => Promise<void>> = [];
    const cancellation = await cancelIngestionSessions(repository, new IngestionIrreversibleCoordinator(), retired.session.owner,
      [{ ...retired.session, expected_version: retired.session.version }], () => undefined, {},
      { readCommitted: async () => new Map(), scheduleCleanup: work => { scheduled.push(work); } });
    assert.equal(cancellation[0]?.status, "discarded");
    assert.equal(scheduled.length, 1);
    const newGeneration = randomUuidV7();
    const newRaw = raw.ingestionRawPath("import", retired.session, newGeneration);
    await writeFile(newRaw, "next generation");
    await scheduled[0]!();
    await assert.rejects(stat(retired.path), { code: "ENOENT" });
    assert.equal(await readFile(newRaw, "utf8"), "next generation");
    await removeIngestionRaw("import", retired.session, newGeneration);
  } finally { await runtime.runtimeConfigStore.replaceRuntimeConfig(previous); }

  const cursorPair = { session_id: identity.createIngestionSessionId("raw-cursor", "import", "tail"), image_id: randomUuidV7() };
  const cursorNow = Date.now();
  const cursorPaths = Array.from({ length: 9 }, (_, index) => raw.ingestionRawPath("import", cursorPair, randomUuidV7At(new Date(cursorNow + index))));
  await mkdir(dirname(cursorPaths[0]!), { recursive: true });
  for (const path of cursorPaths) { await writeFile(path, "cursor"); await utimes(path, new Date(1_000), new Date(1_000)); }
  const cursorKept = cursorPaths.slice(0, -1);
  const keep = new Set([...protectedRawPaths, ...cursorKept]);
  const tail = cursorPaths.at(-1)!;
  const restoreBudget = installProperties(appConfig.ingestionRuntime, { orphanCleanupMaxRawEntriesPerCycle: 4 });
  let slice = new AbortController();
  let slicedCycles = 0;
  let injectSlice = false;
  const originalRead = Dir.prototype.read;
  const restoreRead = installProperties(Dir.prototype, {
    read: function (this: Dir, callback?: (error: NodeJS.ErrnoException | null, entry: Dirent | null) => void) {
      if (callback) return Reflect.apply(originalRead, this, [callback]);
      // Dir.read() without a callback is the native promise overload.
      return (Reflect.apply(originalRead, this, []) as Promise<Dirent | null>).then(entry => {
        if (injectSlice && !slice.signal.aborted && entry
          && keep.has(cursorPaths.find(path => basename(path) === entry.name) ?? "")) {
          slicedCycles += 1;
          slice.abort(new Error("raw scan time slice"));
        }
        return entry;
      });
    }
  });
  try {
    const preview = await scanner.inspectIngestionRawOrphans({ keep, rawCutoff: cursorNow, partCutoff: cursorNow });
    assert.equal(preview.complete, false);
    assert.equal((await readdir(dirname(tail))).length, cursorPaths.length);
    injectSlice = true;
    let removed = 0;
    for (let cycle = 0; cycle < 30 && removed === 0; cycle += 1) {
      slice = new AbortController();
      const report = await scanner.cleanupIngestionRawOrphans({ keep, rawCutoff: cursorNow, partCutoff: cursorNow, signal: slice.signal });
      removed += report.removed;
      if (slice.signal.aborted) assert.equal(report.complete, false);
    }
    assert.ok(slicedCycles > 1, "repeated time slices must preserve forward progress past retained files");
    assert.equal(removed, 1);
    await assert.rejects(stat(tail), { code: "ENOENT" });
    await scanner.closeIngestionRawCleanupCursor();
    injectSlice = false;
    await writeFile(tail, "cursor");
    await utimes(tail, new Date(1_000), new Date(1_000));
    removed = 0;
    let budgetCycles = 0;
    for (let cycle = 0; cycle < 20 && removed === 0; cycle += 1) {
      budgetCycles += 1;
      removed += (await scanner.cleanupIngestionRawOrphans({ keep, rawCutoff: cursorNow, partCutoff: cursorNow })).removed;
    }
    assert.ok(budgetCycles > 1, "the entry budget must split the traversal into multiple cycles");
    assert.equal(removed, 1, "the bounded cursor eventually reaches the orphan after retained files");
    await assert.rejects(stat(tail), { code: "ENOENT" });
    for (const path of cursorKept) assert.equal(await readFile(path, "utf8"), "cursor");
    await scanner.closeIngestionRawCleanupCursor();
    restoreBudget();
    await scanner.cleanupIngestionRawOrphans({ keep: protectedRawPaths, rawCutoff: cursorNow, partCutoff: cursorNow });
    await scanner.closeIngestionRawCleanupCursor();
    await assert.rejects(stat(dirname(tail)), { code: "ENOENT" });
    await assert.rejects(stat(dirname(dirname(tail))), { code: "ENOENT" });
  } finally { restoreRead(); restoreBudget(); await scanner.closeIngestionRawCleanupCursor(); }
});
