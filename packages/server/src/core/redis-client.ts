import { Redis } from "ioredis";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";

const redisConfig = getRuntimeConfig().redis;

export const redis = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
  lazyConnect: true,
  maxRetriesPerRequest: 1
});

let redisConnectPromise: Promise<unknown> | null = null;

export async function pingRedis() {
  if (redis.status === "wait" || redis.status === "end") {
    redisConnectPromise ??= redis.connect().finally(() => {
      redisConnectPromise = null;
    });
    await redisConnectPromise;
  }
  await redis.ping();
}
