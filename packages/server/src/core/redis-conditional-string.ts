import { execRedisPipeline } from "./redis-pipeline.ts";

type RedisConditionalStringCommandClient = {
  call(command: string, ...arguments_: string[]): Promise<unknown>;
};

type RedisConditionalStringPipeline = {
  call(command: string, ...arguments_: string[]): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
};

type RedisConditionalStringPipelineClient = {
  pipeline(): RedisConditionalStringPipeline;
};

export type RedisStringSnapshot = Readonly<{
  key: string;
  value: string;
}>;

export function parseRedisSetIfEqualReply(reply: unknown) {
  if (reply === "OK") return true;
  if (reply === null) return false;
  throw new Error("Redis SET IFEQ returned an invalid result");
}

export function parseRedisDeleteIfEqualReply(reply: unknown) {
  if (reply === 1) return true;
  if (reply === 0) return false;
  throw new Error("Redis DELEX IFEQ returned an invalid result");
}

export async function replaceRedisStringIfEqualKeepingTtl(
  client: RedisConditionalStringCommandClient,
  key: string,
  expectedValue: string,
  nextValue: string
) {
  const reply = await client.call(
    "SET",
    key,
    nextValue,
    "IFEQ",
    expectedValue,
    "KEEPTTL"
  );
  return parseRedisSetIfEqualReply(reply);
}

export async function deleteRedisStringIfEqual(
  client: RedisConditionalStringCommandClient,
  key: string,
  expectedValue: string
) {
  const reply = await client.call("DELEX", key, "IFEQ", expectedValue);
  return parseRedisDeleteIfEqualReply(reply);
}

export async function deleteRedisStringsIfEqual(
  client: RedisConditionalStringPipelineClient,
  snapshots: readonly RedisStringSnapshot[]
) {
  if (!snapshots.length) return [];
  const pipeline = client.pipeline();
  for (const snapshot of snapshots) {
    pipeline.call("DELEX", snapshot.key, "IFEQ", snapshot.value);
  }
  const results = await execRedisPipeline(pipeline);
  if (results.length !== snapshots.length) {
    throw new Error("Redis DELEX pipeline returned an invalid result count");
  }
  return results.flatMap(([, reply], index) => (
    parseRedisDeleteIfEqualReply(reply) ? [snapshots[index]] : []
  ));
}
