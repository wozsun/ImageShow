import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

function adminImageActionPath(imageId: string, action: "delete" | "restore") {
  return `${adminApiBasePath}/images/${encodeURIComponent(imageId)}/${action}`;
}

export function moveImageToTrash(imageId: string) {
  return api<void>(adminImageActionPath(imageId, "delete"), {
    method: "POST"
  });
}

export function restoreImageFromTrash(imageId: string) {
  return api<void>(adminImageActionPath(imageId, "restore"), {
    method: "POST"
  });
}
