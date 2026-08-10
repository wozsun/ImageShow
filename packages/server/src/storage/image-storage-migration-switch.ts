import { errorMessage } from "../core/api-error.ts";
import { withTransaction } from "../core/database-transactions.ts";
import { withImageMutationSync } from "../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";
import type {
  PreparedImageStorageMigration,
  StorageMigrationResult,
  StorageMigrationState
} from "./image-storage-migration-contract.ts";
import {
  hasStorageMigrationLocation,
  queueStorageMigrationCandidateCleanup,
  readStorageMigrationState,
  settleStorageMigrationSwitchError,
  storageMigrationOutcomeUnknown
} from "./image-storage-migration-settlement.ts";
import { enqueueCapturedObjectsForCleanup } from "./move-cleanup.ts";

export function switchPreparedImageStorageMigration(
  prepared: PreparedImageStorageMigration,
  signal: AbortSignal
): Promise<StorageMigrationResult> {
  const {
    image,
    target,
    created,
    sourceCleanup,
    thumbnailSize
  } = prepared;

  return withImageMutationSync(async (mutationBatch) => {
    const finishMigration = (status: string): StorageMigrationResult => {
      if (status === "ready") mutationBatch.add({ id: image.id });
      return "migrated";
    };

    let switchedStatus: string | null;
    try {
      switchedStatus = await withTransaction(async (client) => {
        signal.throwIfAborted();
        const result = await client.query(
          `UPDATE metadata
              SET storage_slug=$2,
                  thumbnail_size=$5,
                  updated_at=now()
            WHERE id=$1
              AND storage_slug=$3
              AND object_key=$4
          RETURNING status`,
          [
            image.id,
            target,
            image.storage_slug,
            image.object_key,
            thumbnailSize
          ]
        );
        const status = String(result.rows[0]?.status ?? "");
        if (!result.rowCount || !status) return null;
        await enqueueCapturedObjectsForCleanup(
          image.id,
          sourceCleanup,
          "source_cleanup_after_storage_switch",
          client
        );
        if (status === "ready") await bumpReadyImageRevision(client);
        signal.throwIfAborted();
        return status;
      });
    } catch (error) {
      const state = await settleStorageMigrationSwitchError(
        image,
        target,
        created,
        sourceCleanup,
        error
      );
      return finishMigration(state.status);
    }

    if (switchedStatus !== null) return finishMigration(switchedStatus);

    // A zero-row CAS should mean the source is unchanged, but re-read before
    // compensating so an out-of-protocol writer cannot make a target candidate
    // authoritative between the CAS and cleanup decision.
    let state: StorageMigrationState | undefined;
    try {
      state = await readStorageMigrationState(image.id);
    } catch (truthError) {
      throw storageMigrationOutcomeUnknown(
        image,
        target,
        new Error("storage migration compare-and-swap affected no rows"),
        {
          truth_error: errorMessage(truthError),
          target_candidates: created,
          retained_source_objects: sourceCleanup
        }
      );
    }
    if (state && hasStorageMigrationLocation(state, target, image.object_key)) {
      await enqueueCapturedObjectsForCleanup(
        image.id,
        sourceCleanup,
        "source_cleanup_after_storage_switch"
      );
      return finishMigration(state.status);
    }
    if (
      state
      && hasStorageMigrationLocation(
        state,
        image.storage_slug,
        image.object_key
      )
    ) {
      await queueStorageMigrationCandidateCleanup(
        image,
        target,
        created,
        "location_compare_and_swap_failed"
      );
      return "unchanged";
    }
    throw storageMigrationOutcomeUnknown(
      image,
      target,
      new Error("storage migration compare-and-swap affected no rows"),
      {
        actual_storage_slug: state?.storage_slug ?? null,
        actual_object_key: state?.object_key ?? null,
        actual_status: state?.status ?? null,
        target_candidates: created,
        retained_source_objects: sourceCleanup
      }
    );
  });
}
