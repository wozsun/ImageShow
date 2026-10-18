import type { Redis, RedisOptions } from "ioredis";
import {
  publishReadyImageAttributeIndexScript,
  sampleReadyImageCoreIndexScript,
  sampleReadyImageDerivedIndexScript,
  storeReadyImageFilterSetScript,
  touchReadyImageIndexedResultScript,
  touchReadyImageStatsResultScript
} from "./scripts.ts";

const readyImageRedisScripts = Object.freeze({
  imageshowTouchReadyImageIndexedResult: {
    lua: touchReadyImageIndexedResultScript,
    numberOfKeys: 6,
    readOnly: false
  },
  imageshowTouchReadyImageStatsResult: {
    lua: touchReadyImageStatsResultScript,
    numberOfKeys: 6,
    readOnly: false
  },
  imageshowStoreReadyImageFilterSet: {
    lua: storeReadyImageFilterSetScript,
    readOnly: false
  },
  imageshowPublishReadyImageAttributeIndex: {
    lua: publishReadyImageAttributeIndexScript,
    numberOfKeys: 3,
    readOnly: false
  },
  imageshowSampleReadyImageCoreIndex: {
    lua: sampleReadyImageCoreIndexScript,
    numberOfKeys: 4,
    readOnly: true
  },
  imageshowSampleReadyImageDerivedIndex: {
    lua: sampleReadyImageDerivedIndexScript,
    numberOfKeys: 6,
    readOnly: true
  }
}) satisfies NonNullable<RedisOptions["scripts"]>;

export type ReadyImageRedisCommandName = keyof typeof readyImageRedisScripts;
type ReadyImageRedisCommand = (...arguments_: Array<string | number>) => Promise<unknown>;

export type ReadyImageRedisClient = Readonly<
  Record<ReadyImageRedisCommandName, ReadyImageRedisCommand>
>;

type ReadyImageRedisRegistrar = Pick<Redis, "defineCommand">;

export type ReadyImageRedisCommandSource<Name extends ReadyImageRedisCommandName> =
  Readonly<Record<Name, ReadyImageRedisCommand>> | ReadyImageRedisRegistrar;

function readyImageRedisCandidate(client: object) {
  return client as Record<string, unknown>;
}

export function registerReadyImageRedisCommands(
  client: ReadyImageRedisRegistrar
): ReadyImageRedisClient {
  const candidate = readyImageRedisCandidate(client);
  for (const [name, definition] of Object.entries(readyImageRedisScripts)) {
    if (typeof candidate[name] !== "function") {
      client.defineCommand(name, definition);
    }
  }
  return client as unknown as ReadyImageRedisClient;
}

export function readyImageRedisCommandClient<Name extends ReadyImageRedisCommandName>(
  client: ReadyImageRedisCommandSource<Name>,
  name: Name
): Readonly<Record<Name, ReadyImageRedisCommand>> {
  if (typeof readyImageRedisCandidate(client)[name] === "function") {
    return client as Readonly<Record<Name, ReadyImageRedisCommand>>;
  }
  return registerReadyImageRedisCommands(client as ReadyImageRedisRegistrar) as Readonly<
    Record<Name, ReadyImageRedisCommand>
  >;
}
