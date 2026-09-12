import type { z } from "zod";
import {
  ingestionQueueMetadataSchema,
  storedIngestionSessionSchema,
  uploadIntentSchema
} from "./model.ts";

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context} contains invalid JSON`);
  }
}

function parseStoredValue<T extends z.ZodType>(schema: T, value: unknown, context: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Redis ingestion ${context} has invalid structure at ${issue?.path.join(".") || "root"}`);
  }
  return result.data;
}

export function parseStoredIngestionSession(raw: string) {
  return parseStoredValue(storedIngestionSessionSchema, parseJson(raw, "Redis ingestion canonical"), "canonical");
}

export function parseUploadIntent(raw: string) {
  return parseStoredValue(uploadIntentSchema, parseJson(raw, "Redis upload intent"), "upload intent");
}

export function parseIngestionQueueMetadata(value: unknown) {
  return parseStoredValue(ingestionQueueMetadataSchema, value, "queue metadata");
}

const metadataIntegerFields = new Set(
  Object.keys(ingestionQueueMetadataSchema.shape).filter((key) => key !== "owner" && key !== "queue")
);

export function metadataFromHashReply(values: unknown[]) {
  if (values.length % 2 !== 0) {
    throw new Error("Redis ingestion queue metadata has an invalid field count");
  }
  const metadata: Record<string, unknown> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error("Redis ingestion queue metadata contains invalid fields");
    }
    if (metadataIntegerFields.has(key)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
        throw new Error("Redis ingestion queue metadata contains invalid integer text");
      }
      const integer = Number(value);
      if (!Number.isSafeInteger(integer)) {
        throw new Error("Redis ingestion queue metadata contains an unsafe integer");
      }
      metadata[key] = integer;
    } else {
      metadata[key] = value;
    }
  }
  return parseIngestionQueueMetadata(metadata);
}
