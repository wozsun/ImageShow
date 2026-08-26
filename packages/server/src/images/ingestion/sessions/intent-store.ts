import { appConfig } from "@imageshow/shared";
import { ApiError } from "../../../core/api-error.ts";
import {
  parseStoredIngestionSession,
  parseUploadIntent
} from "./codec.ts";
import {
  throwIngestionCommandConflict,
  type IngestionSessionCommandRunner
} from "./command-runner.ts";
import { ingestionSessionKeys, ingestionUploadIntentKey } from "./keys.ts";
import type { UploadIntentSnapshot } from "./model.ts";
import {
  parseIntentReply,
  redisReplyArray,
  redisReplyInteger,
  redisReplyString
} from "./replies.ts";

type UploadIntentPair = Readonly<{
  session_id: string;
  candidate_image_id: string;
  request_hash: string;
}>;

export async function createStoredUploadIntent(
  run: IngestionSessionCommandRunner,
  intent: UploadIntentSnapshot
) {
  const keys = ingestionSessionKeys(intent.owner, "upload", intent.session_id);
  const raw = await run(
    "imageshowCreateUploadIntent",
    ingestionUploadIntentKey(intent.owner, intent.session_id),
    keys.canonical,
    keys.owner,
    keys.display,
    keys.metadata,
    keys.runnable,
    keys.expires,
    JSON.stringify(intent),
    appConfig.ingestionRuntime.uploadIntentTtlSeconds,
    intent.created_at
  );
  const result = parseIntentReply(raw);
  if (result.code === 2) {
    return {
      kind: "canonical" as const,
      session: parseStoredIngestionSession(result.serialized)
    };
  }
  return {
    kind: "intent" as const,
    created: result.code === 0,
    intent: parseUploadIntent(result.serialized)
  };
}

export async function readStoredUploadIntent(
  run: IngestionSessionCommandRunner,
  owner: string,
  sessionId: string
) {
  const raw = await run(
    "imageshowReadUploadIntent",
    ingestionUploadIntentKey(owner, sessionId)
  );
  const reply = redisReplyArray(raw, "upload-intent read");
  const status = redisReplyInteger(reply[0], "upload-intent read status");
  if (status === 0 && reply.length === 1) return null;
  if (status !== 1 || reply.length !== 7) {
    throw new Error("Redis upload-intent read returned an invalid shape");
  }
  const intent = parseUploadIntent(redisReplyString(
    reply[1],
    "upload-intent snapshot"
  ));
  const directFields = [
    intent.session_id,
    intent.candidate_image_id,
    intent.request_hash,
    intent.display_order_key,
    intent.execution_token
  ];
  for (let index = 0; index < directFields.length; index += 1) {
    if (
      redisReplyString(reply[index + 2], "upload-intent field")
        !== directFields[index]
    ) {
      throw new ApiError(
        409,
        "upload_intent_state_conflict",
        "上传意图结构与当前操作不一致"
      );
    }
  }
  if (intent.owner !== owner || intent.session_id !== sessionId) {
    throw new ApiError(
      409,
      "upload_intent_state_conflict",
      "上传意图结构与当前操作不一致"
    );
  }
  return intent;
}

export async function mutateStoredUploadIntent(
  run: IngestionSessionCommandRunner,
  action: "claim" | "heartbeat" | "release",
  owner: string,
  pair: UploadIntentPair,
  token: string,
  now = Date.now()
) {
  const raw = await run(
    "imageshowMutateUploadIntent",
    ingestionUploadIntentKey(owner, pair.session_id),
    action,
    pair.session_id,
    pair.candidate_image_id,
    pair.request_hash,
    token,
    now,
    appConfig.ingestionRuntime.uploadIntentTtlSeconds,
    appConfig.ingestionRuntime.uploadClaimStaleSeconds * 1000
  );
  const reply = redisReplyArray(raw, "upload-intent mutation");
  const code = redisReplyInteger(reply[0], "upload-intent mutation status");
  if (code === -3) {
    throw new ApiError(409, "upload_in_progress", "该图片正在由另一上传请求接收");
  }
  if (code < 0) throwIngestionCommandConflict(code);
  return parseUploadIntent(redisReplyString(
    reply[1],
    "upload-intent mutation snapshot"
  ));
}
