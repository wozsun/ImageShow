import type { Redis, RedisOptions } from "ioredis";
import {
  publishReadyImageAttributeIndexScript,
  sampleReadyImageCoreIndexScript,
  sampleReadyImageDerivedIndexScript,
  storeReadyImageFilterSetScript,
  touchReadyImageIndexedResultScript,
  touchReadyImageStatsResultScript
} from "./scripts.ts";

export const readyImageRedisScripts = Object.freeze({
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
type ReadyImageRedisCommand = (
  ...arguments_: Array<string | number>
) => Promise<unknown>;

export type ReadyImageRedisClient = Readonly<Record<
  ReadyImageRedisCommandName,
  ReadyImageRedisCommand
>>;

export type ReadyImageRedisRegistrar = Pick<Redis, "defineCommand"> &
  Partial<Pick<Redis, "options">>;

export type ReadyImageRedisCommandSource<
  Name extends ReadyImageRedisCommandName
> = Readonly<Record<Name, ReadyImageRedisCommand>> | ReadyImageRedisRegistrar;

function readyImageRedisCandidate(client: object) {
  return client as Record<string, unknown>;
}

function hasReadyImageRedisCommands(
  client: ReadyImageRedisClient | ReadyImageRedisRegistrar
): client is ReadyImageRedisClient {
  const candidate = readyImageRedisCandidate(client);
  return Object.keys(readyImageRedisScripts).every(
    (name) => typeof candidate[name] === "function"
  );
}

function isReadyImageRedisRegistrar(
  client: ReadyImageRedisClient | ReadyImageRedisRegistrar
): client is ReadyImageRedisRegistrar {
  return typeof readyImageRedisCandidate(client).defineCommand === "function";
}

function persistReadyImageRedisScripts(client: ReadyImageRedisRegistrar) {
  if (!client.options) return;
  client.options.scripts = {
    ...client.options.scripts,
    ...readyImageRedisScripts
  };
}

export function registerReadyImageRedisCommands(
  client: ReadyImageRedisClient | ReadyImageRedisRegistrar
): ReadyImageRedisClient {
  if (!isReadyImageRedisRegistrar(client)) {
    if (hasReadyImageRedisCommands(client)) return client;
    throw new Error("Ready-image Redis client cannot register commands");
  }

  persistReadyImageRedisScripts(client);
  const candidate = readyImageRedisCandidate(client);
  for (const [name, definition] of Object.entries(readyImageRedisScripts)) {
    if (typeof candidate[name] !== "function") {
      client.defineCommand(name, definition);
    }
  }
  return client as unknown as ReadyImageRedisClient;
}

export function readyImageRedisCommandClient<
  Name extends ReadyImageRedisCommandName
>(
  client: ReadyImageRedisCommandSource<Name>,
  name: Name
): Readonly<Record<Name, ReadyImageRedisCommand>> {
  if (typeof readyImageRedisCandidate(client)[name] === "function") {
    return client as Readonly<Record<Name, ReadyImageRedisCommand>>;
  }
  return registerReadyImageRedisCommands(
    client as ReadyImageRedisRegistrar
  ) as Readonly<
    Record<Name, ReadyImageRedisCommand>
  >;
}
