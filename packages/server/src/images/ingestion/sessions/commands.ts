import type { Redis, RedisOptions } from "ioredis";
import {
  createIngestionCanonicalScript,
  mutateIngestionCanonicalScript
} from "./scripts/canonical.ts";
import {
  discoverIngestionSessionsScript,
  readIngestionSessionsScript
} from "./scripts/discovery.ts";
import {
  createUploadIntentScript,
  mutateUploadIntentScript,
  readUploadIntentScript
} from "./scripts/intents.ts";
import {
  deleteStaleCompletedReceiptsScript,
  readIngestionQueueSnapshotScript,
  scanIngestionQueueActionScript
} from "./scripts/queue.ts";

const ingestionSessionRedisScripts = Object.freeze({
  imageshowCreateIngestionCanonical: {
    lua: createIngestionCanonicalScript,
    numberOfKeys: 7,
    readOnly: false
  },
  imageshowMutateIngestionCanonical: {
    lua: mutateIngestionCanonicalScript,
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
  imageshowReadIngestionQueueSnapshot: {
    lua: readIngestionQueueSnapshotScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowScanIngestionQueueAction: {
    lua: scanIngestionQueueActionScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowDeleteStaleCompletedReceipts: {
    lua: deleteStaleCompletedReceiptsScript,
    numberOfKeys: 5,
    readOnly: false
  },
  imageshowDiscoverIngestionSessions: {
    lua: discoverIngestionSessionsScript,
    numberOfKeys: 3,
    readOnly: false
  },
  imageshowReadIngestionSessions: {
    lua: readIngestionSessionsScript,
    numberOfKeys: 8,
    readOnly: false
  }
}) satisfies NonNullable<RedisOptions["scripts"]>;

export type IngestionSessionRedisCommandName = keyof typeof ingestionSessionRedisScripts;
type IngestionSessionRedisCommand = (
  ...arguments_: Array<string | number>
) => Promise<unknown>;

export type IngestionSessionRedisClient = Readonly<Record<
  IngestionSessionRedisCommandName,
  IngestionSessionRedisCommand
>>;

type IngestionSessionRedisSourceClient =
  | IngestionSessionRedisClient
  | Pick<Redis, "defineCommand">;

function hasIngestionSessionRedisCommands(
  client: IngestionSessionRedisSourceClient
): client is IngestionSessionRedisClient {
  const candidate = client as unknown as Record<string, unknown>;
  return Object.keys(ingestionSessionRedisScripts).every(
    (name) => typeof candidate[name] === "function"
  );
}

export function registerIngestionSessionRedisCommands(
  client: IngestionSessionRedisSourceClient
): IngestionSessionRedisClient {
  if (hasIngestionSessionRedisCommands(client)) return client;
  for (const [name, definition] of Object.entries(ingestionSessionRedisScripts)) {
    client.defineCommand(name, definition);
  }
  return client as unknown as IngestionSessionRedisClient;
}
