import { metadataUpdateInput, parse } from "../core/validation.ts";
import { updateImageClassification } from "./metadata-classification-mutation.ts";
import { updateImageFields } from "./metadata-field-mutation.ts";
import type { ImageMutationOptions } from "./metadata-mutation-contract.ts";

export function updateImageMetadata(
  id: string,
  body: unknown,
  options: ImageMutationOptions = {}
) {
  const parsed = parse(metadataUpdateInput, body);
  const classificationRequested = parsed.device !== undefined
    || parsed.brightness !== undefined
    || parsed.theme !== undefined;

  return classificationRequested
    ? updateImageClassification(id, parsed, options)
    : updateImageFields(id, parsed, options);
}
