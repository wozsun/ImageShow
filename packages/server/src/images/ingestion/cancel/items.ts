import type {
  IngestionCancelItemInputDto,
  IngestionCancelItemResultDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import type { CommittedIngestionResult } from "../../read-models/ingestion-results.ts";
import type {
  IngestionSessionPair,
  StoredIngestionSession
} from "../sessions/model.ts";
import {
  ingestionSessionIncarnationMismatch,
  IngestionSessionRepository
} from "../repository.ts";

export type LoadedCancelItem = Readonly<{
  owner: string;
  input: IngestionCancelItemInputDto;
  session: StoredIngestionSession | null;
  incarnationMismatch?: boolean;
}>;

export function cancelFailure(
  input: IngestionSessionPair,
  error: unknown
): IngestionCancelItemResultDto {
  return {
    ...input,
    status: "failed",
    code: error instanceof ApiError ? error.code : "ingestion_cancel_failed",
    message: error instanceof Error ? error.message : "Ingestion cancel failed"
  };
}

export function completedCancelResult(
  pair: IngestionSessionPair,
  result: CommittedIngestionResult
): IngestionCancelItemResultDto {
  return {
    ...pair,
    status: "completed",
    completed_item: result.item
  };
}

export async function loadCancelItems(
  repository: IngestionSessionRepository,
  owner: string,
  items: readonly IngestionCancelItemInputDto[]
): Promise<LoadedCancelItem[]> {
  const sessions = await repository.readSessions(owner, items);
  return items.map((input, index) => ({
    owner,
    input,
    session: sessions[index] === ingestionSessionIncarnationMismatch
      ? null
      : sessions[index] ?? null,
    incarnationMismatch: sessions[index] === ingestionSessionIncarnationMismatch
  }));
}
