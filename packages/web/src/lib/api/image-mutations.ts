import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto,
  ImageRestoreResponseDto,
  ImageTrashResponseDto
} from "@imageshow/shared/browser";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

function imageActionRequest<T>(path: string, body: unknown) {
  return api<T>(`${adminApiBasePath}/images/${path}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function moveImagesToTrash(ids: string[]) {
  return imageActionRequest<ImageTrashResponseDto>("trash", { ids });
}

export function restoreImages(ids: string[]) {
  return imageActionRequest<ImageRestoreResponseDto>("restore", { ids });
}

export function purgeImages(request: ImagePurgeRequestDto) {
  return imageActionRequest<ImagePurgeResponseDto>("purge", request);
}
