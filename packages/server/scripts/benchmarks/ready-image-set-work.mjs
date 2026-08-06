import Redis from "ioredis";
import { performance } from "node:perf_hooks";

const redis = new Redis({ host: "127.0.0.1", port: 16379, lazyConnect: true });
const prefix = `benchmark:ready-image-set-work:${process.pid}`;
const populateBatchSize = 1_000;

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function populate(key, start, count) {
  for (let offset = 0; offset < count; offset += populateBatchSize) {
    const size = Math.min(populateBatchSize, count - offset);
    const args = [];
    for (let index = 0; index < size; index += 1) {
      const value = start + offset + index;
      args.push(String(value), `member:${value.toString().padStart(8, "0")}`);
    }
    await redis.zadd(key, ...args);
  }
}

async function measure(work, iterations) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  return {
    p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
    max_ms: Number(Math.max(...samples).toFixed(3))
  };
}

const guardedStoreScript = `
local source_count = #KEYS - 1
for index = 1, source_count do
  if redis.call('ZCARD', KEYS[index]) ~= tonumber(ARGV[index]) then
    return {0, index}
  end
end
local command = ARGV[source_count + 1]
local expected = tonumber(ARGV[source_count + 2])
local ttl = tonumber(ARGV[source_count + 3])
local destination = KEYS[source_count + 1]
local arguments = {destination, tostring(source_count)}
for index = 1, source_count do table.insert(arguments, KEYS[index]) end
if command ~= 'ZDIFFSTORE' then
  table.insert(arguments, 'AGGREGATE')
  table.insert(arguments, 'MAX')
end
local stored = redis.call(command, unpack(arguments))
if stored > expected then
  redis.call('UNLINK', destination)
  return {-1, stored}
end
if stored > 0 then redis.call('EXPIRE', destination, ttl) end
return {1, stored}
`;

async function guardedStore(command, destination, sources, expected) {
  const result = await redis.call(
    "EVAL",
    guardedStoreScript,
    String(sources.length + 1),
    ...sources.map(({ key }) => key),
    destination,
    ...sources.map(({ count }) => String(count)),
    command,
    String(expected),
    "300"
  );
  if (!Array.isArray(result) || Number(result[0]) !== 1) {
    throw new Error("Guarded store benchmark failed");
  }
  return Number(result[1]);
}

await redis.connect();
const allKeys = [];
try {
  for (const size of [1_000, 25_000, 50_000, 100_000]) {
    const iterations = size === 100_000 ? 3 : size === 50_000 ? 5 : 7;
    const dimensions = size === 100_000
      ? [8, 16, 32]
      : size === 50_000
        ? [16, 32, 64]
        : [16, 64, 128];
    const scenario = `${prefix}:${size}`;
    const sources = Array.from({ length: 4 }, (_, index) => (
      `${scenario}:source:${index}`
    ));
    const destination = `${scenario}:destination`;
    const compositeUnion = `${scenario}:composite:union`;
    const compositeIntersection = `${scenario}:composite:intersection`;
    allKeys.push(
      ...sources,
      destination,
      compositeUnion,
      compositeIntersection
    );
    await Promise.all(sources.map((key, index) => (
      populate(key, Math.floor(index * size / 2), size)
    )));

    const result = {
      members_per_source: size,
      repeats: iterations,
      summed_source_members: size * sources.length,
      union_4: await measure(async () => {
        await redis.call(
          "ZUNIONSTORE",
          destination,
          String(sources.length),
          ...sources,
          "AGGREGATE",
          "MAX"
        );
        await redis.unlink(destination);
      }, iterations),
      intersection_4: await measure(async () => {
        await redis.call(
          "ZINTERSTORE",
          destination,
          String(sources.length),
          ...sources,
          "AGGREGATE",
          "MAX"
        );
        await redis.unlink(destination);
      }, iterations),
      difference_4: await measure(async () => {
        await redis.call(
          "ZDIFFSTORE",
          destination,
          String(sources.length),
          ...sources
        );
        await redis.unlink(destination);
      }, iterations),
      include_intersect_exclude_zero_result: await measure(async () => {
        const unionCount = await guardedStore(
          "ZUNIONSTORE",
          compositeUnion,
          [
            { key: sources[0], count: size },
            { key: sources[1], count: size }
          ],
          size * 2
        );
        const intersectionCount = await guardedStore(
          "ZINTERSTORE",
          compositeIntersection,
          [
            { key: compositeUnion, count: unionCount },
            { key: sources[2], count: size }
          ],
          Math.min(unionCount, size)
        );
        await guardedStore(
          "ZDIFFSTORE",
          destination,
          [
            { key: compositeIntersection, count: intersectionCount },
            { key: sources[1], count: size }
          ],
          intersectionCount
        );
        const count = await redis.zcard(destination);
        if (count !== 0) throw new Error("Composite benchmark must be empty");
        await redis.unlink(destination, compositeUnion, compositeIntersection);
      }, iterations),
      intersection_cardinality_2: await measure(() => (
        redis.call("ZINTERCARD", "2", sources[0], sources[1])
      ), iterations),
      intersection_cardinality_dimensions: {}
    };
    for (const count of dimensions) {
      result.intersection_cardinality_dimensions[count] = await measure(
        async () => {
          const pipeline = redis.pipeline();
          for (let index = 0; index < count; index += 1) {
            pipeline.call(
              "ZINTERCARD",
              "2",
              sources[0],
              sources[(index % 3) + 1]
            );
          }
          await pipeline.exec();
        },
        size === 100_000 ? 2 : 5
      );
    }
    console.log(JSON.stringify(result));
    await redis.unlink(
      ...sources,
      destination,
      compositeUnion,
      compositeIntersection
    );
  }

  const targetCore = `${prefix}:target:core`;
  const targetDestination = `${prefix}:target:destination`;
  const targetExclusions = [1, 25_000, 100_000].map((count) => ({
    count,
    key: `${prefix}:target:exclude:${count}`
  }));
  allKeys.push(
    targetCore,
    targetDestination,
    ...targetExclusions.map(({ key }) => key)
  );
  await populate(targetCore, 0, 100_000);
  for (const { count, key } of targetExclusions) {
    await populate(key, 0, count);
  }
  const targetResult = {
    target_core_members: 100_000,
    repeats: 5,
    exclusion_difference: {}
  };
  for (const { count, key } of targetExclusions) {
    targetResult.exclusion_difference[count] = await measure(async () => {
      await guardedStore(
        "ZDIFFSTORE",
        targetDestination,
        [
          { key: targetCore, count: 100_000 },
          { key, count }
        ],
        100_000
      );
      const actual = await redis.zcard(targetDestination);
      if (actual !== 100_000 - count) {
        throw new Error("Target-scale exclusion result is inconsistent");
      }
      await redis.unlink(targetDestination);
    }, targetResult.repeats);
  }
  console.log(JSON.stringify(targetResult));
  await redis.unlink(
    targetCore,
    targetDestination,
    ...targetExclusions.map(({ key }) => key)
  );
} finally {
  if (allKeys.length) await redis.unlink(...allKeys);
  await redis.quit();
}
