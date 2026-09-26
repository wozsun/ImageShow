import { join } from "node:path";
import { imageVariantDirectories, type ImageVariant } from "@imageshow/shared/browser";
import { runtimePaths } from "../../config/bootstrap-env.ts";

export function preparationId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid preparation identifier");
  return id;
}
export function preparationWorkDirectory(run: string, image: string, attempt: string) {
  return join(runtimePaths.configDirectory, "normalize-preparation", preparationId(run), preparationId(image), preparationId(attempt));
}
export function preparationTarget(image: string, variant: ImageVariant) {
  preparationId(image);
  return join(runtimePaths.storageDirectory, imageVariantDirectories[variant], image.slice(-2), `${image}.webp`);
}
export function preparationCandidate(image: string, variant: ImageVariant, token: string) {
  return `${preparationTarget(image, variant)}.${preparationId(token)}.prepare`;
}
