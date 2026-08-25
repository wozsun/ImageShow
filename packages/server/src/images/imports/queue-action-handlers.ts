import type {
  ImageDraftDto,
  ImportCancelItemResultDto,
  ImportCommitItemInputDto,
  ImportQueueActionInputDto,
  ImportQueueActionResultDto,
  ImportQueueActionTypeDto,
  ImportSessionPairDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import {
  committedImportResultForOwner,
  readCommittedImportResultsByImageIds
} from "../read-models/import-results.ts";
import { cancelImportSessions } from "./cancel-session.ts";
import { acceptImportCommitIntents } from "./commit-intent.ts";
import type { ImportIrreversibleCoordinator } from "./irreversible-coordinator.ts";
import {
  importSessionPairKey as pairKey,
  type CompletedImportReceipt,
  type ImportSessionPair,
  type ImportSessionSnapshot,
  type StoredImportSession
} from "./session-model.ts";
import {
  importSessionIncarnationMismatch,
  type ImportSessionRepository
} from "./session-repository.ts";
import { semanticImportSession } from "./session-transitions.ts";

type ActionItem = ImportQueueActionResultDto["items"][number];

function pair(session: StoredImportSession): ImportSessionPairDto {
  return {
    session_id: session.session_id,
    image_id: session.image_id
  };
}

function changed(
  session: StoredImportSession,
  completedItem?: ActionItem["completed_item"]
): ActionItem {
  return {
    ...pair(session),
    status: "changed",
    ...(completedItem ? { completed_item: completedItem } : {})
  };
}

function unchanged(
  session: StoredImportSession,
  completedItem?: ActionItem["completed_item"]
): ActionItem {
  return {
    ...pair(session),
    status: "unchanged",
    ...(completedItem ? { completed_item: completedItem } : {})
  };
}

function skipped(
  session: StoredImportSession,
  code: string,
  message: string
): ActionItem {
  return { ...pair(session), status: "skipped", code, message };
}

function failed(session: StoredImportSession, error: unknown): ActionItem {
  return {
    ...pair(session),
    status: "failed",
    code: error instanceof ApiError ? error.code : "import_action_failed",
    message: error instanceof Error ? error.message : "导入队列操作失败"
  };
}

const queueActionMutationAttempts = 8;

function isImportVersionConflict(error: unknown) {
  return error instanceof ApiError && error.code === "import_version_conflict";
}

function metadataForAction(
  session: ImportSessionSnapshot,
  patch: Readonly<Partial<ImageDraftDto>>
) {
  const prepared = session.prepared;
  const directFields = [
    "title",
    "description",
    "source",
    "original"
  ] as const;
  const metadata = { ...session.metadata };
  for (const field of directFields) {
    if (patch[field] !== undefined) metadata[field] = patch[field];
  }
  if (patch.device !== undefined) {
    metadata.device = patch.device === "auto" && prepared
      ? prepared.detected_device
      : patch.device;
  }
  if (patch.brightness !== undefined) {
    metadata.brightness = patch.brightness === "auto" && prepared
      ? prepared.detected_brightness
      : patch.brightness;
  }
  if (patch.theme?.trim()) metadata.theme = patch.theme;
  if (patch.author?.trim()) metadata.author = patch.author;
  if (patch.tags?.length) {
    metadata.tags = [...new Set([...metadata.tags, ...patch.tags])];
  }
  return metadata;
}

async function applyMetadataAction(input: Readonly<{
  repository: ImportSessionRepository;
  sessions: readonly StoredImportSession[];
  metadata: Readonly<Partial<ImageDraftDto>>;
  assertScope: () => unknown;
}>) {
  return mapWithWorkerPool(
    input.sessions,
    10,
    async (initialSession): Promise<ActionItem> => {
      try {
        let session = initialSession;
        for (
          let attempt = 0;
          attempt < queueActionMutationAttempts;
          attempt += 1
        ) {
          input.assertScope();
          if (session.status === "completed" || session.status === "discarded") {
            return skipped(
              session,
              "import_action_predicate_changed",
              "当前任务已不再保存可修改草稿"
            );
          }
          if (session.commit) {
            return skipped(
              session,
              "import_action_predicate_changed",
              "当前任务的提交意图已经冻结"
            );
          }
          const metadata = metadataForAction(session, input.metadata);
          const next = semanticImportSession(session, { metadata });
          try {
            const result = await input.repository.mutateSemantic(
              session,
              session.version,
              next
            );
            return result.changed
              ? changed(result.session)
              : unchanged(result.session);
          } catch (error) {
            if (
              !isImportVersionConflict(error)
              || attempt === queueActionMutationAttempts - 1
            ) {
              throw error;
            }
          }

          input.assertScope();
          const current = await input.repository.readSession(
            session.owner,
            session.session_id
          );
          if (
            !current
            || current.image_id.toLowerCase() !== session.image_id.toLowerCase()
          ) {
            return skipped(
              initialSession,
              "import_action_predicate_changed",
              "当前任务身份已经变化或不再存在"
            );
          }
          session = current;
        }
        throw new Error("Import metadata action exhausted its mutation attempts");
      } catch (error) {
        return failed(initialSession, error);
      }
    }
  );
}

function commitInput(
  session: ImportSessionSnapshot,
  actionRequestId: string
): ImportCommitItemInputDto {
  if (!session.prepared) {
    throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
  }
  if (session.commit?.commit_request_id === actionRequestId) {
    return {
      ...pair(session),
      expected_version: session.version,
      expected_md5: session.commit.expected_md5,
      commit_request_id: actionRequestId,
      duplicate_decision: session.commit.duplicate_decision,
      metadata: session.commit.metadata
    };
  }
  return {
    ...pair(session),
    expected_version: session.version,
    expected_md5: session.prepared.md5,
    commit_request_id: actionRequestId,
    duplicate_decision: session.duplicate_decision ?? "upload",
    metadata: session.metadata
  };
}

async function commitReadyAction(input: Readonly<{
  repository: ImportSessionRepository;
  owner: string;
  sessions: readonly StoredImportSession[];
  actionRequestId: string;
  capturedRevision: number;
  assertScope: () => unknown;
}>) {
  const results = new Map<string, ActionItem>();
  const selected: Array<{
    session: ImportSessionSnapshot;
    request: ImportCommitItemInputDto;
    retry: boolean;
  }> = [];
  const completedRetries = input.sessions.filter((session) => (
    session.status === "completed"
    && session.commit_request_id === input.actionRequestId
  )) as CompletedImportReceipt[];
  if (completedRetries.length) {
    input.assertScope();
    const committed = await readCommittedImportResultsByImageIds(
      completedRetries.map((session) => session.image_id)
    );
    for (const session of completedRetries) {
      const committedResult = committedImportResultForOwner(
        committed,
        session.image_id,
        input.owner
      );
      if (committedResult) {
        results.set(
          pairKey(session),
          unchanged(session, committedResult.item)
        );
      } else {
        try {
          await input.repository.deleteSession(session, session.version);
          results.set(pairKey(session), changed(session));
        } catch (error) {
          results.set(pairKey(session), failed(session, error));
        }
      }
    }
  }

  for (const session of input.sessions) {
    if (results.has(pairKey(session))) continue;
    if (session.status === "completed" || session.status === "discarded") {
      results.set(pairKey(session), skipped(
        session,
        "import_action_predicate_changed",
        "当前任务已不再处于可提交状态"
      ));
      continue;
    }
    const retry = session.commit?.commit_request_id === input.actionRequestId;
    if (!retry && session.last_semantic_revision > input.capturedRevision) {
      results.set(pairKey(session), skipped(
        session,
        "import_action_state_changed",
        "任务在操作确认后已发生变化"
      ));
      continue;
    }
    const ready = session.status === "ready"
      && Boolean(session.prepared)
      && (
        !session.prepared?.duplicate_count
        || Boolean(session.duplicate_decision)
      );
    if (!retry && !ready) {
      results.set(pairKey(session), skipped(
        session,
        "import_action_predicate_changed",
        "当前任务已不再处于可提交状态"
      ));
      continue;
    }
    try {
      selected.push({
        session,
        request: commitInput(session, input.actionRequestId),
        retry
      });
    } catch (error) {
      results.set(pairKey(session), failed(session, error));
    }
  }

  if (selected.length) {
    input.assertScope();
    const accepted = await acceptImportCommitIntents(
      input.repository,
      input.owner,
      selected.map((item) => item.request)
    );
    accepted.forEach((result, index) => {
      const selectedItem = selected[index]!;
      if (result.status === "failed") {
        results.set(pairKey(selectedItem.session), {
          ...pair(selectedItem.session),
          status: "failed",
          code: result.code,
          message: result.message
        });
        return;
      }
      if (result.status === "completed") {
        results.set(
          pairKey(selectedItem.session),
          selectedItem.retry
            ? unchanged(selectedItem.session, result.completed_item)
            : changed(selectedItem.session, result.completed_item)
        );
        return;
      }
      results.set(
        pairKey(selectedItem.session),
        selectedItem.retry
          ? unchanged(selectedItem.session)
          : changed(selectedItem.session)
      );
    });
  }
  return input.sessions.map((session) => results.get(pairKey(session))
    ?? skipped(session, "import_action_predicate_changed", "当前任务未被处理"));
}

function cancelPredicate(
  action: ImportQueueActionTypeDto,
  session: StoredImportSession
) {
  if (action === "clear_queue") return session.status !== "discarded";
  if (action === "clear_completed") return session.status === "completed";
  if (session.status === "completed" || session.status === "discarded") {
    return false;
  }
  if (action === "clear_duplicate_pending") {
    return session.status === "ready"
      && Boolean(session.prepared?.duplicate_count)
      && !session.duplicate_decision;
  }
  if (action === "clear_uncommitted") {
    return session.status !== "committing" && session.status !== "resolving";
  }
  return false;
}

function cancelActionSkip(
  action: ImportQueueActionTypeDto,
  capturedRevision: number,
  session: StoredImportSession
) {
  if (
    action !== "clear_queue"
    && session.last_semantic_revision > capturedRevision
  ) {
    return skipped(
      session,
      "import_action_state_changed",
      "任务在操作确认后已发生变化"
    );
  }
  if (!cancelPredicate(action, session)) {
    return skipped(
      session,
      "import_action_predicate_changed",
      "任务不再符合当前清理条件"
    );
  }
  return null;
}

async function clearQueueAction(input: Readonly<{
  repository: ImportSessionRepository;
  coordinator: ImportIrreversibleCoordinator;
  owner: string;
  sessions: readonly StoredImportSession[];
  action: ImportQueueActionTypeDto;
  capturedRevision: number;
  abortActive: (pair: ImportSessionPair) => void | Promise<unknown>;
  assertScope: () => unknown;
}>) {
  const results = new Map<string, ActionItem>();
  const selected: StoredImportSession[] = [];
  for (const session of input.sessions) {
    const skip = cancelActionSkip(
      input.action,
      input.capturedRevision,
      session
    );
    if (skip) {
      results.set(pairKey(session), skip);
      continue;
    }
    selected.push(session);
  }

  const deleteCompleted = async (
    completed: readonly CompletedImportReceipt[]
  ) => {
    if (!completed.length) return;
    input.assertScope();
    const committed = await readCommittedImportResultsByImageIds(
      completed.map((session) => session.image_id)
    );
    await mapWithWorkerPool(completed, 10, async (session) => {
      try {
        input.assertScope();
        await input.repository.deleteSession(session, session.version);
        const committedResult = committedImportResultForOwner(
          committed,
          session.image_id,
          input.owner
        );
        results.set(
          pairKey(session),
          changed(session, committedResult?.item)
        );
      } catch (error) {
        results.set(pairKey(session), failed(session, error));
      }
    });
  };

  await deleteCompleted(selected.filter((session) => (
    session.status === "completed"
  )) as CompletedImportReceipt[]);

  const active = selected.filter((session): session is ImportSessionSnapshot => (
    session.status !== "completed" && session.status !== "discarded"
  ));
  if (active.length) {
    const recordCancelResult = async (
      session: ImportSessionSnapshot,
      result: ImportCancelItemResultDto
    ) => {
      if (result.status === "discarded") {
        results.set(pairKey(session), changed(session));
        return;
      }
      if (result.status === "resolving") {
        results.set(pairKey(session), skipped(
          session,
          "import_action_resolving",
          "数据库事务已经开始，任务将保留到结果明确"
        ));
        return;
      }
      if (result.status === "failed") {
        results.set(pairKey(session), {
          ...pair(session),
          status: "failed",
          code: result.code,
          message: result.message
        });
        return;
      }
      try {
        input.assertScope();
        const current = await input.repository.readSession(
          input.owner,
          session.session_id
        );
        if (
          current?.status === "completed"
          && current.image_id.toLowerCase() === session.image_id.toLowerCase()
        ) {
          await input.repository.deleteSession(current, current.version);
          results.set(
            pairKey(session),
            changed(session, result.completed_item)
          );
        } else {
          results.set(
            pairKey(session),
            unchanged(session, result.completed_item)
          );
        }
      } catch (error) {
        results.set(pairKey(session), failed(session, error));
      }
    };

    let pending = active.map((session) => ({ initial: session, session }));
    for (
      let attempt = 0;
      pending.length && attempt < queueActionMutationAttempts;
      attempt += 1
    ) {
      input.assertScope();
      const cancelled = await cancelImportSessions(
        input.repository,
        input.coordinator,
        input.owner,
        pending.map(({ session }) => ({
          ...pair(session),
          expected_version: session.version
        })),
        input.abortActive
      );
      const versionConflicts: typeof pending = [];
      for (const [index, result] of cancelled.entries()) {
        const target = pending[index]!;
        if (
          result.status === "failed"
          && result.code === "import_version_conflict"
          && attempt < queueActionMutationAttempts - 1
        ) {
          versionConflicts.push(target);
        } else {
          await recordCancelResult(target.initial, result);
        }
      }
      if (!versionConflicts.length) break;

      input.assertScope();
      const refreshed = await input.repository.readSessions(
        input.owner,
        versionConflicts.map(({ initial }) => pair(initial))
      );
      const nextPending: typeof pending = [];
      const newlyCompleted: CompletedImportReceipt[] = [];
      for (const [index, target] of versionConflicts.entries()) {
        const current = refreshed[index];
        if (
          !current
          || current === importSessionIncarnationMismatch
          || current.image_id.toLowerCase()
            !== target.initial.image_id.toLowerCase()
        ) {
          results.set(pairKey(target.initial), skipped(
            target.initial,
            "import_action_predicate_changed",
            "当前任务身份已经变化或不再存在"
          ));
          continue;
        }
        const skip = cancelActionSkip(
          input.action,
          input.capturedRevision,
          current
        );
        if (skip) {
          results.set(pairKey(target.initial), skip);
        } else if (current.status === "completed") {
          newlyCompleted.push(current);
        } else if (current.status !== "discarded") {
          nextPending.push({ initial: target.initial, session: current });
        }
      }
      await deleteCompleted(newlyCompleted);
      pending = nextPending;
    }
  }
  return input.sessions.map((session) => results.get(pairKey(session))
    ?? skipped(session, "import_action_predicate_changed", "当前任务未被处理"));
}

export function executeImportQueueActionBatch(input: Readonly<{
  repository: ImportSessionRepository;
  coordinator: ImportIrreversibleCoordinator;
  owner: string;
  request: ImportQueueActionInputDto;
  sessions: readonly StoredImportSession[];
  capturedRevision: number;
  abortActive: (pair: ImportSessionPair) => void | Promise<unknown>;
  assertScope: () => unknown;
}>) {
  if (input.request.action === "apply_metadata") {
    return applyMetadataAction({
      repository: input.repository,
      sessions: input.sessions,
      metadata: input.request.metadata ?? {},
      assertScope: input.assertScope
    });
  }
  if (input.request.action === "commit_ready") {
    return commitReadyAction({
      repository: input.repository,
      owner: input.owner,
      sessions: input.sessions,
      actionRequestId: input.request.action_request_id,
      capturedRevision: input.capturedRevision,
      assertScope: input.assertScope
    });
  }
  return clearQueueAction({
    repository: input.repository,
    coordinator: input.coordinator,
    owner: input.owner,
    sessions: input.sessions,
    action: input.request.action,
    capturedRevision: Math.min(
      input.capturedRevision,
      input.request.max_semantic_revision ?? input.capturedRevision
    ),
    abortActive: input.abortActive,
    assertScope: input.assertScope
  });
}
