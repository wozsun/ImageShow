import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  db: env.REDIS_DB,
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
