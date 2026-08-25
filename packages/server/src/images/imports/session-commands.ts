import type { Redis, RedisOptions } from "ioredis";
import {
  createImportCanonicalScript,
  createUploadIntentScript,
  deleteStaleCompletedReceiptsScript,
  discoverImportSessionsScript,
  mutateImportCanonicalScript,
  mutateUploadIntentScript,
  readImportQueueSnapshotScript,
  readImportSessionsScript,
  readUploadIntentScript,
  scanImportQueueActionScript
} from "./session-scripts.ts";

const importSessionRedisScripts = Object.freeze({
  imageshowCreateImportCanonical: {
    lua: createImportCanonicalScript,
    numberOfKeys: 7,
    readOnly: false
  },
  imageshowMutateImportCanonical: {
    lua: mutateImportCanonicalScript,
    numberOfKeys: 6,
    readOnly: false
  },
  imageshowCreateUploadIntent: {
    lua: createUploadIntentScript,
    numberOfKeys: 7,
    readOnly: false
  },
  imageshowMutateUploadIntent: {
    lua: mutateUploadIntentScript,
    numberOfKeys: 1,
    readOnly: false
  },
  imageshowReadUploadIntent: {
    lua: readUploadIntentScript,
    numberOfKeys: 1,
    readOnly: true
  },
  imageshowReadImportQueueSnapshot: {
    lua: readImportQueueSnapshotScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowScanImportQueueAction: {
    lua: scanImportQueueActionScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowDeleteStaleCompletedReceipts: {
    lua: deleteStaleCompletedReceiptsScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowDiscoverImportSessions: {
    lua: discoverImportSessionsScript,
    numberOfKeys: 3,
    readOnly: false
  },
  imageshowReadImportSessions: {
    lua: readImportSessionsScript,
    numberOfKeys: 8,
    readOnly: false
  }
}) satisfies NonNullable<RedisOptions["scripts"]>;

export type ImportSessionRedisCommandName = keyof typeof importSessionRedisScripts;
type ImportSessionRedisCommand = (
  ...arguments_: Array<string | number>
) => Promise<unknown>;

export type ImportSessionRedisClient = Readonly<Record<
  ImportSessionRedisCommandName,
  ImportSessionRedisCommand
>>;

type ImportSessionRedisSourceClient =
  | ImportSessionRedisClient
  | Pick<Redis, "defineCommand">;

function hasImportSessionRedisCommands(
  client: ImportSessionRedisSourceClient
): client is ImportSessionRedisClient {
  const candidate = client as unknown as Record<string, unknown>;
  return Object.keys(importSessionRedisScripts).every(
    (name) => typeof candidate[name] === "function"
  );
}

export function registerImportSessionRedisCommands(
  client: ImportSessionRedisSourceClient
): ImportSessionRedisClient {
  if (hasImportSessionRedisCommands(client)) return client;
  for (const [name, definition] of Object.entries(importSessionRedisScripts)) {
    client.defineCommand(name, definition);
  }
  return client as unknown as ImportSessionRedisClient;
}
