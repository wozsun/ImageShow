import type {
  StorageLayoutUpgradeBatchResponseDto,
  StorageLayoutUpgradeStatusDto
} from "@imageshow/shared/browser";
import { api } from "../../../../lib/api/client.js";
import { adminApiBasePath } from "../../../../lib/constants.js";

const storageLayoutUpgradePath =
  `${adminApiBasePath}/check/storage-layout-upgrade`;

export function readStorageLayoutUpgradeStatus(signal?: AbortSignal) {
  return api<StorageLayoutUpgradeStatusDto>(storageLayoutUpgradePath, {
    signal
  });
}

export function runStorageLayoutUpgradeBatch(
  limit: number,
  signal?: AbortSignal
) {
  return api<StorageLayoutUpgradeBatchResponseDto>(
    `${storageLayoutUpgradePath}/batch`,
    {
      method: "POST",
      body: JSON.stringify({ limit }),
      signal
    }
  );
}
