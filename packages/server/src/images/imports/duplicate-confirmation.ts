import type {
  AdminImageListItemDto,
  StoredImportBatchCommitItemInputDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import {
  getDuplicateSnapshotByMd5,
  readDuplicateSnapshotByMd5
} from "../read-models/duplicates.ts";
import type {
  ImportDuplicateCheck,
  ImportDuplicateConfirmation,
  PreparedPayload
} from "./types.ts";

type DuplicateCommitInput = Pick<
  StoredImportBatchCommitItemInputDto,
  "commit_attempt_id" | "duplicate_decision" | "expected_md5"
>;

export function importContentLockKey(md5: string) {
  return `imageshow:import-content:${md5}`;
}

export async function captureImportDuplicateCheck(md5: string): Promise<{
  check: ImportDuplicateCheck;
  duplicates: AdminImageListItemDto[];
}> {
  const snapshot = await getDuplicateSnapshotByMd5(md5);
  return {
    check: { md5, match_count: snapshot.matchCount },
    duplicates: snapshot.items
  };
}

function confirmationFromInput(
  payload: PreparedPayload,
  input: DuplicateCommitInput
): ImportDuplicateConfirmation {
  if (input.expected_md5 !== payload.md5) {
    throw new ApiError(
      409,
      "import_prepared_content_changed",
      "准备提交的图片内容已变化，请重新处理"
    );
  }
  return {
    commit_attempt_id: input.commit_attempt_id,
    expected_md5: input.expected_md5,
    decision: input.duplicate_decision
  };
}

function sameConfirmation(
  left: ImportDuplicateConfirmation,
  right: ImportDuplicateConfirmation
) {
  return left.commit_attempt_id === right.commit_attempt_id
    && left.expected_md5 === right.expected_md5
    && left.decision === right.decision;
}

export function resolveImportDuplicateConfirmation(
  status: "ready" | "committing",
  payload: PreparedPayload,
  input: DuplicateCommitInput
) {
  const requested = confirmationFromInput(payload, input);
  const stored = payload.duplicate_confirmation;
  if (
    stored
    && (
      stored.commit_attempt_id !== requested.commit_attempt_id
      || stored.expected_md5 !== requested.expected_md5
    )
  ) {
    throw new ApiError(
      409,
      "import_commit_intent_conflict",
      "提交尝试与服务端已锁定的提交意图不一致"
    );
  }
  if (status === "committing" && stored && !sameConfirmation(stored, requested)) {
    throw new ApiError(
      409,
      "import_commit_intent_conflict",
      "提交尝试与服务端已锁定的提交意图不一致"
    );
  }
  if (stored?.decision === "confirmed") return stored;
  return requested;
}

export async function assertImportDuplicateDecision(
  id: string,
  payload: PreparedPayload,
  confirmation: ImportDuplicateConfirmation
) {
  const duplicates = (await readDuplicateSnapshotByMd5(payload.md5)).items
    .filter((item) => item.id.toLowerCase() !== id.toLowerCase());
  if (duplicates.length && confirmation.decision !== "confirmed") {
    throw new ApiError(
      409,
      "import_duplicate_conflict",
      "提交前发现相同内容图片，请确认是否仍然提交",
      { duplicates }
    );
  }
}
