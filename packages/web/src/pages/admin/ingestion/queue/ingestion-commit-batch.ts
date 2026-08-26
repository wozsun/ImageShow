import { ingestionBatchHardLimit } from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import {
  commitStoredIngestions,
  getIngestionStatuses
} from "./ingestion-api.js";
import { ingestionStatusEventPatch } from "./model/ingestion-status-state.js";
import {
  completedIngestionObservations,
  type CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import { serverIngestionPairKey } from "./model/server-ingestion-job.js";

type CommitSelectedIngestionsOptions = {
  selected: IngestionJob[];
  getJob: (id: string) => IngestionJob | undefined;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
  updateJob: (id: string, patch: Partial<IngestionJob>) => void;
};

function commitInput(job: IngestionJob) {
  if (
    !job.sessionId
    || !job.imageId
    || !job.serverVersion
    || !job.commitIntent
  ) {
    throw new Error("提交任务缺少服务端 pair、版本或提交意图");
  }
  return {
    session_id: job.sessionId,
    image_id: job.imageId.toLowerCase(),
    expected_version: job.serverVersion,
    expected_md5: job.commitIntent.md5,
    commit_request_id: job.commitIntent.attemptId,
    duplicate_decision: job.duplicateDecision === "confirmed"
      ? "confirmed" as const
      : "upload" as const,
    metadata: job.commitIntent.metadata
  };
}

function currentCommitJob(
  options: CommitSelectedIngestionsOptions,
  selected: IngestionJob
) {
  const current = options.getJob(selected.id);
  return current?.commitIntent?.attemptId === selected.commitIntent?.attemptId
    ? current
    : undefined;
}

async function reconcileUnknownBatch(
  options: CommitSelectedIngestionsOptions,
  selected: IngestionJob[],
  error: unknown
) {
  try {
    const states = await getIngestionStatuses(selected.map((job) => ({
      session_id: job.sessionId!,
      image_id: job.imageId!
    })));
    const completed = completedIngestionObservations(states);
    const statesByPair = new Map(states.map((state) => [
      serverIngestionPairKey(state),
      state
    ]));
    for (const job of selected) {
      const current = currentCommitJob(options, job);
      if (!current) continue;
      const state = statesByPair.get(serverIngestionPairKey({
        session_id: job.sessionId!,
        image_id: job.imageId!
      }));
      if (!state) continue;
      const patch = ingestionStatusEventPatch(current, state);
      if (patch) options.updateJob(current.id, patch);
      if (state.status === "present" && state.item.status === "ready") {
        options.updateJob(current.id, {
          status: "failed",
          failureStage: "commit",
          commitFailureCheckpoint: "ready",
          resultState: undefined,
          message: "提交尚未受理，请重试"
        });
      }
    }
    return completed;
  } catch {
    const message = error instanceof Error ? error.message : String(error);
    for (const job of selected) {
      const current = currentCommitJob(options, job);
      if (!current) continue;
      options.updateJob(current.id, {
        status: "failed",
        failureStage: "commit",
        commitFailureCheckpoint: "unknown",
        resultState: undefined,
        message: `提交结果暂时无法确认：${message}`
      });
    }
    return [];
  }
}

async function commitBatch(
  options: CommitSelectedIngestionsOptions,
  selected: IngestionJob[]
) {
  let response: Awaited<ReturnType<typeof commitStoredIngestions>>;
  try {
    response = await commitStoredIngestions(selected.map(commitInput));
  } catch (error) {
    return {
      accepted: 0,
      completed: await reconcileUnknownBatch(options, selected, error)
    };
  }
  const results = new Map(response.items.map((result) => [
    serverIngestionPairKey(result),
    result
  ]));
  let accepted = 0;
  const completed: CompletedIngestionObservation[] = [];
  for (const job of selected) {
    const current = currentCommitJob(options, job);
    if (!current) continue;
    const result = results.get(serverIngestionPairKey({
      session_id: job.sessionId!,
      image_id: job.imageId!
    }));
    if (!result) {
      options.updateJob(current.id, {
        status: "failed",
        failureStage: "commit",
        commitFailureCheckpoint: "unknown",
        resultState: undefined,
        message: "提交响应没有包含当前任务"
      });
      continue;
    }
    if (result.status === "failed") {
      if (
        result.code === "import_duplicate_conflict"
        && result.duplicates?.length
      ) {
        options.updateJob(current.id, {
          status: "ready",
          failureStage: undefined,
          commitFailureCheckpoint: undefined,
          resultState: undefined,
          duplicates: result.duplicates,
          duplicateCount: result.duplicate_count ?? result.duplicates.length,
          duplicateDecision: "undecided",
          ...(result.version ? { serverVersion: result.version } : {}),
          message: result.message
        });
      } else {
        options.updateJob(current.id, {
          status: "failed",
          failureStage: "commit",
          commitFailureCheckpoint: result.code === "invalid_import_state"
            ? "ready"
            : "unknown",
          resultState: undefined,
          message: result.message
        });
      }
      continue;
    }
    if (result.status === "completed") {
      completed.push({
        pair: result,
        item: result.completed_item
      });
    }
    accepted += 1;
    options.updateJob(current.id, {
      status: result.status === "completed" ? "finalized" : "committing",
      serverVersion: result.version,
      serverStatus: result.status === "completed" ? "completed" : "committing",
      serverAttemptKey: current.attemptKey,
      serverSessionId: current.sessionId,
      serverImageId: current.imageId,
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      resultState: "recovering",
      resultError: undefined,
      message: result.status === "completed"
        ? "服务端已确认写入，正在读取结果"
        : "提交已受理，等待服务器写入"
    });
  }
  return { accepted, completed };
}

export async function commitSelectedIngestions(
  options: CommitSelectedIngestionsOptions
) {
  let accepted = 0;
  const completed: CompletedIngestionObservation[] = [];
  try {
    for (
      let offset = 0;
      offset < options.selected.length;
      offset += ingestionBatchHardLimit
    ) {
      const batch = await commitBatch(
        options,
        options.selected.slice(offset, offset + ingestionBatchHardLimit)
      );
      accepted += batch.accepted;
      completed.push(...batch.completed);
    }
  } finally {
    if (completed.length) options.observeCompletedIngestions(completed);
  }
  return accepted;
}
