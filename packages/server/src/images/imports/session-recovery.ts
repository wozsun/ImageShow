import { access } from "node:fs/promises";
import { appConfig } from "@imageshow/shared";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import {
  committedImportResultForOwner,
  readCommittedImportResultsByImageIds
} from "../read-models/import-results.ts";
import { cancelRecoveredImportSessions } from "./cancel-session.ts";
import { publishCompletedReceipt } from "./commit-worker.ts";
import { ImportIrreversibleCoordinator } from "./irreversible-coordinator.ts";
import { importRawPath } from "./raw-files.ts";
import type {
  ImportSessionPair,
  ImportSessionSnapshot,
  StoredImportSession
} from "./session-model.ts";
import { ImportSessionRepository } from "./session-repository.ts";
import {
  failedImportSession,
  semanticImportSession
} from "./session-transitions.ts";

type AbortActiveImport = (pair: ImportSessionPair) => Promise<unknown> | void;
type CommittedImportResults = Awaited<
  ReturnType<typeof readCommittedImportResultsByImageIds>
>;

const recoveryRaceCodes = new Set([
  "import_session_missing",
  "import_session_expired",
  "import_session_not_expired",
  "import_incarnation_conflict",
  "import_version_conflict",
  "import_execution_fenced"
]);

function isRecoveryRace(error: unknown) {
  return error instanceof ApiError && recoveryRaceCodes.has(error.code);
}

export type ImportSessionRecoveryDependencies = Readonly<{
  now: () => number;
  readCommitted: typeof readCommittedImportResultsByImageIds;
  cancel: typeof cancelRecoveredImportSessions;
  publishCompleted: typeof publishCompletedReceipt;
  rawExists: (session: ImportSessionSnapshot) => Promise<boolean>;
  newExecutionToken: () => string;
}>;

const defaultDependencies: ImportSessionRecoveryDependencies = {
  now: Date.now,
  readCommitted: readCommittedImportResultsByImageIds,
  cancel: cancelRecoveredImportSessions,
  publishCompleted: publishCompletedReceipt,
  rawExists: async (session) => {
    if (!session.raw_generation) return false;
    return access(importRawPath(
      session.queue,
      session,
      session.raw_generation
    )).then(() => true, () => false);
  },
  newExecutionToken: randomUuidV7
};

/**
 * Performs one bounded recovery slice at a time. Expiry is always drained
 * before unexpired sessions are normalized for the runnable worker pools.
 */
export class ImportSessionRecovery {
  readonly #repository: ImportSessionRepository;
  readonly #coordinator: ImportIrreversibleCoordinator;
  readonly #abortActive: AbortActiveImport;
  readonly #dependencies: ImportSessionRecoveryDependencies;
  #offset = 0;
  #recoveredInPass = 0;
  #complete = false;
  readonly #requeuedCommitTokens = new Set<string>();

  constructor(
    repository: ImportSessionRepository,
    coordinator: ImportIrreversibleCoordinator,
    abortActive: AbortActiveImport,
    dependencies: Partial<ImportSessionRecoveryDependencies> = {}
  ) {
    this.#repository = repository;
    this.#coordinator = coordinator;
    this.#abortActive = abortActive;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  get complete() {
    return this.#complete;
  }

  reset() {
    this.#offset = 0;
    this.#recoveredInPass = 0;
    this.#complete = false;
    this.#requeuedCommitTokens.clear();
  }

  async step() {
    if (this.#complete) return true;
    const now = this.#dependencies.now();
    if (await this.drainExpired(now)) {
      // Expiry removes or re-scores members in the same ZSET used by the
      // offset scan. Restart the pass so that rank shifts cannot skip an
      // unexpired execution state waiting behind the removed page.
      this.#offset = 0;
      this.#recoveredInPass = 0;
      return false;
    }

    const page = await this.#repository.discoverExpiryPage(this.#offset);
    this.#recoveredInPass += page.missing + await this.#recoverPage(
      page.items
        .map(({ session }) => session)
        .filter((session) => session.discard_at > now)
    );
    this.#offset += page.items.length;
    if (page.scanned >= appConfig.importRuntime.recoveryScanBatchSize) {
      return false;
    }
    if (this.#recoveredInPass) {
      this.#offset = 0;
      this.#recoveredInPass = 0;
      return false;
    }
    this.#complete = true;
    return true;
  }

  async drainExpired(now = this.#dependencies.now()) {
    const expired = await this.#repository.discoverExpired(now);
    if (!expired.length) return false;
    await this.#expireSessions(
      expired.map(({ session }) => session),
      now
    );
    return true;
  }

  async #expireSessions(sessions: StoredImportSession[], cutoff: number) {
    const active: ImportSessionSnapshot[] = [];
    for (const session of sessions) {
      if (session.status !== "completed" && session.status !== "discarded") {
        active.push(session as ImportSessionSnapshot);
        continue;
      }
      try {
        await this.#repository.expireSession(
          session,
          session.version,
          cutoff
        );
      } catch (error) {
        if (!isRecoveryRace(error)) throw error;
      }
    }
    await this.#cancelSessions(active, cutoff);
  }

  async #cancelSessions(
    sessions: readonly ImportSessionSnapshot[],
    expiryCutoff?: number
  ) {
    let changed = 0;
    const settling: Promise<unknown>[] = [];
    const results = await this.#dependencies.cancel(
      this.#repository,
      this.#coordinator,
      sessions,
      this.#abortActive,
      expiryCutoff === undefined ? {} : { expiryCutoff }
    );
    for (const result of results) {
      if (result.status === "failed") {
        const code = result.code ?? "import_recovery_cancel_failed";
        if (recoveryRaceCodes.has(code)) continue;
        throw new ApiError(
          409,
          code,
          result.message ?? "导入恢复取消失败"
        );
      }
      changed += 1;
      if (result.status === "resolving") {
        const settled = this.#coordinator.settled(result);
        if (settled) settling.push(settled);
      }
    }
    if (settling.length) await Promise.allSettled(settling);
    return changed;
  }

  async #recoverPage(sessions: readonly StoredImportSession[]) {
    const committing = sessions.filter((session): session is ImportSessionSnapshot => (
      session.status === "committing" || session.status === "resolving"
    ));
    const committed = await this.#dependencies.readCommitted(
      [...new Set(committing.map((session) => session.image_id))]
    );
    const resolvingToCancel: ImportSessionSnapshot[] = [];
    const settling: Promise<unknown>[] = [];
    let changed = 0;
    for (const session of sessions) {
      const result = await this.#recoverSession(
        session,
        committed,
        resolvingToCancel,
        settling
      );
      if (result) changed += 1;
    }
    changed += await this.#cancelSessions(resolvingToCancel);
    if (settling.length) {
      await Promise.allSettled(settling);
      changed += settling.length;
    }
    return changed;
  }

  async #recoverSession(
    session: StoredImportSession,
    committed: CommittedImportResults,
    resolvingToCancel: ImportSessionSnapshot[],
    settling: Promise<unknown>[]
  ) {
    if (session.status === "completed" || session.status === "discarded") {
      return false;
    }
    const active = session as ImportSessionSnapshot;
    if (active.status === "downloading") {
      const next = semanticImportSession(active, {
        status: "queued",
        phase: "queued",
        message: "应用恢复后等待重新下载",
        progress: null,
        execution_token: "",
        raw_generation: "",
        raw_size: 0
      });
      await this.#repository.mutateSemantic(active, active.version, next);
      return true;
    }
    if (active.status === "preparing") {
      const next = await this.#dependencies.rawExists(active)
        ? semanticImportSession(active, {
          status: "received",
          phase: "received",
          message: "应用恢复后等待重新处理",
          progress: null,
          execution_token: ""
        })
        : failedImportSession(
          active,
          new ApiError(409, "import_raw_missing", "恢复时原始素材已不存在")
        );
      await this.#repository.mutateSemantic(active, active.version, next);
      return true;
    }
    if (active.status === "committing" || active.status === "resolving") {
      if (committedImportResultForOwner(
        committed,
        active.image_id,
        active.owner
      )) {
        await this.#dependencies.publishCompleted(
          this.#repository,
          active,
          this.#dependencies.now()
        );
      } else if (this.#coordinator.state(active) === "database_started") {
        const transaction = this.#coordinator.settled(active);
        if (transaction) settling.push(transaction);
      } else if (active.status === "resolving") {
        resolvingToCancel.push(active);
      } else {
        const currentExecution = [
          active.session_id,
          active.image_id,
          active.execution_token
        ].join("\0");
        if (this.#requeuedCommitTokens.has(currentExecution)) return false;
        const next = semanticImportSession(active, {
          status: "committing",
          phase: "committing",
          message: "应用恢复后重新确认提交",
          progress: null,
          execution_token: this.#dependencies.newExecutionToken()
        });
        const recovered = await this.#repository.mutateSemantic(
          active,
          active.version,
          next
        );
        this.#requeuedCommitTokens.add([
          recovered.session.session_id,
          recovered.session.image_id,
          "execution_token" in recovered.session
            ? recovered.session.execution_token
            : ""
        ].join("\0"));
      }
      return true;
    }
    return false;
  }
}
