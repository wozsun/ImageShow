import type { z } from "zod";
import type { EntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import type { metadataUpdateInput } from "../core/validation.ts";
import type { ImageRecord } from "./presenter.ts";

export type MetadataMutationInput = z.output<typeof metadataUpdateInput>;

export type ImageMutationOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
};

export type MutationImageRecord = Pick<
  ImageRecord,
  | "id"
  | "device"
  | "brightness"
  | "theme"
  | "width"
  | "height"
  | "ext"
  | "md5"
  | "object_key"
  | "storage_slug"
  | "author"
  | "status"
>;

export const mutationImageColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "ext",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "status"
].join(", ");
