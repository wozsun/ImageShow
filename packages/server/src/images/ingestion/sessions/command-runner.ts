import type { Redis } from "ioredis";
import { ApiError } from "../../../core/api-error.ts";
import { redis } from "../../../core/redis/client.ts";
import { runRequiredRedisCommand } from "../../../core/runtime-availability.ts";
import {
  registerIngestionSessionRedisCommands,
  type IngestionSessionRedisClient,
  type IngestionSessionRedisCommandName
} from "./commands.ts";

export type IngestionRepositoryCommand = <T>(
  work: () => Promise<T>
) => Promise<T>;

export type IngestionSessionCommandRunner = (
  command: IngestionSessionRedisCommandName,
  ...arguments_: Array<string | number>
) => Promise<unknown>;

export function ingestionQueueStructureError() {
  return new ApiError(
    503,
    "import_queue_structure_invalid",
    "内容接入队列结构异常，请停止应用后清空 ImageShow 专用 Redis 逻辑库"
  );
}

export function throwIngestionCommandConflict(code: number): never {
  if (code === -1) {
    throw new ApiError(410, "upload_intent_expired", "上传意图已过期，请重新签发");
  }
  if (code === -2) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "同一幂等身份已用于不同内容接入意图"
    );
  }
  if (code === -3) {
    throw new ApiError(410, "upload_intent_expired", "上传意图已过期，请重新签发");
  }
  if (code === -4) {
    throw new ApiError(409, "import_execution_fenced", "内容接入执行权已转移");
  }
  throw new Error(`Redis import command returned unexpected status ${code}`);
}

function ingestionDomainReplyError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object"
      && error !== null
      && "message" in error
      && typeof error.message === "string"
      ? error.message
      : null;
  if (!message) return null;
  if (/\b(?:IMPORT_QUEUE_STRUCTURE|WRONGTYPE)\b/u.test(message)) {
    return ingestionQueueStructureError();
  }
  if (/\bIMPORT_CANONICAL\b/u.test(message)) {
    return new ApiError(
      409,
      "import_session_state_conflict",
      "内容接入任务状态与当前操作不一致"
    );
  }
  if (/\bIMPORT_INTENT\b/u.test(message)) {
    return new ApiError(
      409,
      "upload_intent_state_conflict",
      "上传意图状态与当前操作不一致"
    );
  }
  return null;
}

async function runIngestionRedisCommand<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const domainError = ingestionDomainReplyError(error);
    if (domainError) throw domainError;
    return runRequiredRedisCommand<T>(() => Promise.reject(error));
  }
}

export function createIngestionSessionCommandRunner(
  client: IngestionSessionRedisClient | Pick<Redis, "defineCommand"> = redis,
  command: IngestionRepositoryCommand = runIngestionRedisCommand
): IngestionSessionCommandRunner {
  const registeredClient = registerIngestionSessionRedisCommands(client);
  return (name, ...arguments_) => command(
    () => registeredClient[name](...arguments_)
  );
}
