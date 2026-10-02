import { randomUUIDv7 } from "node:crypto";
import { imageVariants } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { ApiError } from "../../../core/api-error.ts";
import { runWithAdvisoryLockAcquisitionSignal } from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import { removeIngestionPreparedFiles, writeIngestionPreparedFile } from "../raw/prepared.ts";
import { detectBrightness } from "../../brightness.ts";
import { withNormalizationAdmission } from "../../normalization-admission.ts";
import {
  transcodeStoredImage
} from "../../processing.ts";
import { getDuplicateMatchCountByMd5 } from "../../read-models/duplicates.ts";
import { ingestionCleanupRetryQueue } from "../cleanup/retry-queue.ts";
import {
  mutateIngestionExecution,
  refreshIngestionExecutionSession,
  updateIngestionExecutionProgress
} from "../execution/session.ts";
import { removeOwnedIngestionRaw } from "../raw/files.ts";
import { withActiveIngestionTempPaths } from "../raw/lease-registry.ts";
import {
  ingestionRawPath,
  ingestionPreparedFile,
  ingestionPreparedPath,
  ingestionPreparedFiles
} from "../raw/paths.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";
import { withIngestionPreparationAdmission } from "./preparation-admission.ts";

export function preparedAttemptIsReferenced(
  current: StoredIngestionSession | null,
  expected: Pick<IngestionSessionSnapshot, "session_id" | "image_id">,
  files: readonly string[]
) {
  return Boolean(
    current &&
    current.session_id === expected.session_id &&
    current.image_id === expected.image_id &&
    "prepared" in current &&
    current.prepared &&
    ingestionPreparedFiles(current, current.prepared).every(
      (file, index) => file === files[index]
    )
  );
}

async function cleanupPreparedAttempt(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  files: readonly string[]
) {
  const removeIfUnreferenced = async () => {
    const current = await repository.readSession(session.owner, session.session_id);
    // A semantic publish can succeed even when its response is lost. Preserve
    // the exact objects referenced by the canonical snapshot.
    if (preparedAttemptIsReferenced(
      current,
      session,
      files
    )) return;
    await removeIngestionPreparedFiles(files);
  };
  try {
    await removeIfUnreferenced();
    return;
  } catch (error) {
    logger.warn("ingestion_prepared_attempt_cleanup_deferred", {
      session_id: session.session_id,
      image_id: session.image_id,
      error: error
    });
  }
  // The retry re-reads Redis before every delete attempt. Unknown ownership
  // therefore remains fail-closed without losing the exact local file references.
  await ingestionCleanupRetryQueue.enqueue(removeIfUnreferenced);
}

export async function prepareIngestionSessionSnapshot(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  signal: AbortSignal,
  dependencies: Readonly<{
    transcode?: typeof transcodeStoredImage;
    onNormalizationAdmitted?: () => void;
  }> = {}
) {
  if (session.status !== "preparing"
    || !session.execution_token
    || !session.raw_generation) {
    throw new ApiError(409, "invalid_ingestion_state", "内容接入任务不能进入处理阶段");
  }
  const preparedGeneration = randomUUIDv7();
  const attemptIdentity = {
    session_id: session.session_id,
    image_id: session.image_id,
    generation: preparedGeneration,
    execution_token: session.execution_token
  };
  const preparedFiles = imageVariants.map((variant) => ingestionPreparedFile(attemptIdentity, variant));
  const rawPath = ingestionRawPath(
    session,
    session.raw_generation
  );
  const transcode = dependencies.transcode ?? transcodeStoredImage;
  let enteredLocalWrite = false;

  const prepareAndPublish = async () => {
    const runtime = getRuntimeConfig();
    let current = session;
    const normalizedState = await withNormalizationAdmission(signal, async () => {
      current = await updateIngestionExecutionProgress(repository, current, {
        phase: "normalizing",
        message: "校验格式并生成大、中、小三档图片",
        progress: null
      });
      dependencies.onNormalizationAdmitted?.();
      const normalized = await transcode(
        rawPath,
        runtime.normalize,
        signal
      );
      signal.throwIfAborted();
      current = await refreshIngestionExecutionSession(repository, current);
      current = await updateIngestionExecutionProgress(repository, current, {
        phase: "detecting",
        message: "确认图片尺寸、设备类型和明暗",
        progress: null
      });
      const detectedBrightness = await detectBrightness(normalized.variants.small.data);
      signal.throwIfAborted();
      current = await refreshIngestionExecutionSession(repository, current);
      return { normalized, detectedBrightness };
    });
    const { normalized, detectedBrightness } = normalizedState;
    current = await updateIngestionExecutionProgress(repository, current, {
      phase: "staging",
      message: "在本地保存三档处理结果",
      progress: null
    });
    signal.throwIfAborted();
    enteredLocalWrite = true;
    const writes = await Promise.allSettled(imageVariants.map((variant, index) =>
      writeIngestionPreparedFile(preparedFiles[index]!, normalized.variants[variant].data, signal)
    ));
    const failure = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    signal.throwIfAborted();
    current = await refreshIngestionExecutionSession(repository, current);
    const duplicateCount = await getDuplicateMatchCountByMd5(normalized.variants.large.facts.md5);
    return mutateIngestionExecution(repository, current, (latest) => {
      return {
        ...latest,
        status: "ready" as const,
        phase: "ready",
        message: duplicateCount
          ? "处理完成，请确认重复图片"
          : "处理完成，可以提交",
        progress: 100,
        execution_token: "",
        raw_generation: "",
        raw_size: 0,
        prepared: {
          producer_execution_token: attemptIdentity.execution_token,
          original_size: normalized.sourceSize,
          original_width: normalized.sourceWidth,
          original_height: normalized.sourceHeight,
          variants: {
            large: normalized.variants.large.facts,
            medium: normalized.variants.medium.facts,
            small: normalized.variants.small.facts
          },
          detected_brightness: detectedBrightness,
          duplicate_count: duplicateCount,
          generation: preparedGeneration
        },
        error: undefined
      };
    });
  };

  const prepareAttempt = async () => {
    signal.throwIfAborted();
    const preparedSession = await withIngestionPreparationAdmission(
      signal,
      prepareAndPublish
    );
    await removeOwnedIngestionRaw(
      session,
      session.raw_generation
    ).catch((error) => {
      logger.warn("ingestion_raw_cleanup_deferred", {
        session_id: session.session_id,
        image_id: session.image_id,
        error: error
      });
    });
    return preparedSession;
  };

  try {
    const paths = [
      rawPath,
      ...preparedFiles.flatMap((file) => {
        const path = ingestionPreparedPath(file);
        return [path, path + ".part"];
      })
    ];
    return await withActiveIngestionTempPaths(paths, () =>
      runWithAdvisoryLockAcquisitionSignal(
        signal,
        prepareAttempt
      )
    );
  } catch (error) {
    if (enteredLocalWrite) {
      await cleanupPreparedAttempt(
        repository,
        session,
        preparedFiles
      );
    }
    throw error;
  }
}
