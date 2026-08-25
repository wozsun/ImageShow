import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { assertStorageWriteTarget } from "../../storage/backend-registry.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import {
  importRawPartPath,
  importRawPath,
  receiveUploadRaw,
  removeOwnedImportRaw,
  removeImportRawPart,
  withActiveImportRawPaths
} from "./raw-files.ts";
import { assertImageIdentity } from "./session-identity.ts";
import { ImportSessionService } from "./session-service.ts";

export async function receiveUploadIntentBody(
  service: ImportSessionService,
  owner: string,
  credential: string,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
) {
  if (!body) throw new ApiError(400, "empty_body", "Empty upload body");
  const claims = service.verifyUploadCredential(credential, owner);
  const executionToken = randomUuidV7();
  const intentPair = {
    session_id: claims.session_id,
    candidate_image_id: claims.candidate_image_id,
    request_hash: claims.request_hash
  };
  const claimed = await service.repository.claimUploadIntent(
    owner,
    intentPair,
    executionToken
  );
  const rawGeneration = randomUuidV7();
  const pair = {
    session_id: claimed.session_id,
    image_id: claimed.candidate_image_id
  };
  const rawPath = importRawPath("upload", pair, rawGeneration);
  const partPath = importRawPartPath(
    "upload",
    pair,
    rawGeneration,
    executionToken
  );
  return withActiveImportRawPaths([rawPath, partPath], async () => {
    let published = false;
    try {
      signal?.throwIfAborted();
      const received = await receiveUploadRaw({
        pair,
        raw_generation: rawGeneration,
        execution_token: executionToken,
        body,
        expected_size: claimed.expected_size,
        maximum_size: getInputImageMaxBytes(),
        max_long_edge: claimed.max_long_edge,
        signal,
        heartbeat: () => service.repository.heartbeatUploadIntent(
          owner,
          intentPair,
          executionToken
        ).then(() => undefined)
      });
      published = true;
      signal?.throwIfAborted();
      return await withStorageLocationReadLock(async (lockSignal) => {
        const combinedSignal = signal
          ? AbortSignal.any([signal, lockSignal])
          : lockSignal;
        combinedSignal.throwIfAborted();
        await assertStorageWriteTarget(claimed.storage_slug);
        assertImageIdentity(
          claimed.candidate_image_id,
          claimed.resolved_image_time,
          claimed.manifest_position
        );
        const template = service.uploadReceivedTemplate(
          claimed,
          rawGeneration,
          received.rawSize
        );
        const converted = await service.repository.convertUploadIntent(
          template,
          executionToken
        );
        return converted.session;
      });
    } catch (error) {
      if (published) {
        let retainPublishedRaw = true;
        try {
          const current = await service.repository.readSession(
            owner,
            pair.session_id
          );
          retainPublishedRaw = Boolean(
            current
            && current.image_id === pair.image_id
            && "raw_generation" in current
            && current.raw_generation === rawGeneration
          );
        } catch {
          // A Redis/Lua response can be lost after the conversion committed.
          // Preserve the raw until the bounded orphan cleanup can prove that no
          // canonical references this exact generation.
          retainPublishedRaw = true;
        }
        if (!retainPublishedRaw) {
          await removeOwnedImportRaw("upload", pair, rawGeneration)
            .catch(() => undefined);
        }
      } else {
        await removeImportRawPart(
          "upload",
          pair,
          rawGeneration,
          executionToken
        ).catch(() => undefined);
      }
      await service.repository.releaseUploadIntent(
        owner,
        intentPair,
        executionToken
      ).catch(() => undefined);
      throw error;
    }
  });
}
