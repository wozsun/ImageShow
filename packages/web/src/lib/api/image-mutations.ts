import type {
  ImageDeleteResponseDto,
  ImagePurgeRequestDto,
  ImagePurgeResponseDto,
  ImageRestoreResponseDto
} from "@imageshow/shared/browser";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

function imageActionRequest<T>(path: string, body: unknown) {
  return api<T>(`${adminApiBasePath}/images/${path}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function deleteImages(ids: string[]) {
  return imageActionRequest<ImageDeleteResponseDto>("delete", { ids });
}

export function restoreImages(ids: string[]) {
  return imageActionRequest<ImageRestoreResponseDto>("restore", { ids });
}

export function purgeImages(request: ImagePurgeRequestDto) {
  return imageActionRequest<ImagePurgeResponseDto>("purge", request);
}
